/**
 * 折射场缓存的常量、条目与冷路径：创建条目、创建与绑定缓存纹理。
 *
 * 每帧执行的部分（判断几何是否变化、选择何时求交、淘汰）在 `field-cache.hot.ts`。
 */
import type { StageGpu } from '../gpu'
import type { VolumeTextures } from './volume-shader'
import { TEXTURE_USAGE } from '../gpu'
import { FIELD_FORMATS } from './volume-field-shader'
import { bindVolumeTextures } from './volume-shader'

/** 成员数量不超过它的组才缓存；更多成员的组每帧逐步求交。 */
export const FIELD_MAX_MEMBERS = 8
/** 同时记录的组数。超过时换掉最久没有出现的组。 */
export const FIELD_ENTRIES = 12
/** 每名成员的几何特征占用的浮点数个数：相对位置、半宽高、圆角、厚度与融合、裁剪、色散、截面参数。 */
export const FIELD_SIGNATURE_FLOATS = 22
/** 几何特征的比较容差（CSS 像素）。 */
export const FIELD_TOLERANCE = 0.01
/**
 * 长度类几何特征一次变化不超过它（CSS 像素）时算小幅漂移：弹簧收敛的尾巴、很慢的拖动。
 * 缓存有效时原地重新求交，不作废、不淡出，也不推迟求交。
 */
export const FIELD_DRIFT = 1.5
/** 几何没有明显变化这么久之后才求交并写入缓存，毫秒。期间这一组按剖面光学查表。 */
export const FIELD_SETTLE_MS = 50
/** 刚写完缓存就又明显变化时，等待时间按倍数延长到这个上限，毫秒。轻微拖动不会在查表与缓存之间来回切换。 */
export const FIELD_SETTLE_MAX_MS = 400
/** 写入缓存后这么久之内又明显变化算来回切换，毫秒。 */
export const FIELD_FLAP_MS = 400
/** 变化的成员影响的范围超过缓存面积的这个比例时整组作废，不再局部失效。 */
export const FIELD_LOCAL_LIMIT = 0.6
/** 从查表的画面淡入求交结果的时间，毫秒。 */
export const FIELD_FADE_IN_MS = 100
/** 几何开始变化后，从上一次的求交结果淡出到查表的时间，毫秒。 */
export const FIELD_FADE_OUT_MS = 80
/** 两帧之间计入淡化的最长时间，毫秒。画面静止很久之后的第一帧不会直接跳到终点。 */
export const FIELD_FADE_STEP_MS = 34
/**
 * 全部缓存的纹素总数上限。每个纹素 32 字节（`FIELD_TEXEL_BYTES`），150 万纹素是 48 MB。
 * 超过时先释放最久没有出现的组；单独一组就超过上限时不缓存，静止后每帧逐步求交。
 */
export const FIELD_TEXEL_BUDGET = 1_500_000
/** 连续这么多帧没有出现的组释放缓存纹理。 */
export const FIELD_IDLE_FRAMES = 180
/** 缓存尺寸向上取整的步长（纹素），几何反复小幅变化时不必每次重建纹理。 */
export const FIELD_SIZE_STEP = 32
/** 不参与光路的裁剪边在几何特征里记成的距离。 */
export const FIELD_CLIP_FAR = 1e6

/** 一组折射场纹理。 */
export interface FieldTextures {
  readonly textures: GPUTexture[]
  readonly views: GPUTextureView[]
  /** 纹素尺寸。 */
  readonly width: number
  readonly height: number
}

/** 一组玻璃的折射场缓存与它的状态。对象在 `FieldCache` 里复用。 */
export interface FieldEntry {
  /** 是否记录着一组玻璃。 */
  used: boolean
  /** 组内成员的表面编号，前 `count` 项有效，按编号排列。 */
  readonly ids: Int32Array
  count: number
  /** 上一次变化之后的几何特征，相对第一名成员的中心。 */
  readonly signature: Float32Array
  /** 最近一次出现的帧编号。 */
  frame: number
  /** 最近一次出现的时间，毫秒。 */
  seenAt: number
  /** 几何特征最近一次明显变化（超过 `FIELD_DRIFT`）的时间，毫秒。 */
  changedAt: number
  /** 求交结果（缓存，或没有缓存时的逐帧求交）对应当前的几何。 */
  live: boolean
  /** 缓存有效，但几何在那之后小幅漂移过，要按当前的几何重新求交。 */
  stale: boolean
  /** 求交结果在画面里的比例：0 是查表的画面，1 是求交的画面。 */
  fade: number
  /** 作为原点的成员下标（面积最大的成员），-1 表示还没有选。 */
  anchor: number
  /** 原点成员的中心在本帧视口中的位置。 */
  anchorX: number
  anchorY: number
  /** 写入缓存时各成员的中心与半宽高，相对原点成员。 */
  readonly baked: Float32Array
  /** 写入缓存的时间，毫秒。 */
  bakedAt: number
  /** 当前的等待时间，见 `FIELD_SETTLE_MAX_MS`。 */
  settle: number
  /** 这次写入之后已经延长过等待时间。 */
  flapped: boolean
  /** 局部失效：范围（相对原点成员：左、上、右、下）里查表，其余继续读缓存。 */
  dirty: boolean
  readonly dirtyRect: Float32Array
  /** 局部失效范围里求交结果的比例。 */
  dirtyFade: number
  /** 局部失效范围里最近一次明显变化的时间，毫秒。 */
  dirtyChangedAt: number
  /** 局部失效的范围已经重新写入，正在淡入。 */
  dirtyBaked: boolean
  /** 小幅漂移的成员影响的范围，相对原点成员，下一次写入时原地更新。 */
  readonly refreshRect: Float32Array
  /** 缓存左上角相对第一名成员中心的位置，CSS 像素。 */
  originX: number
  originY: number
  /** 缓存每个 CSS 像素的纹素数，等于写入时的着色倍率。 */
  ratio: number
  /** 缓存纹理；为 null 时没有缓存（超过上限，或没有需要求交的范围）。 */
  textures: FieldTextures | null
  /** 缓存纹理每换一次加一，绑定随之重建。 */
  version: number
  /** 读取这份缓存的纹理绑定：背景、各级模糊、查找表与折射场。 */
  readonly bound: FieldBinding
}

/** 一份缓存的纹理绑定，以及创建它时各部分的版本。 */
export interface FieldBinding extends VolumeTextures {
  source: GPUTextureView | null
  version: number
}

/** 创建一个空条目。 */
export function createFieldEntry(): FieldEntry {
  return {
    used: false,
    ids: new Int32Array(FIELD_MAX_MEMBERS),
    count: 0,
    signature: new Float32Array(FIELD_MAX_MEMBERS * FIELD_SIGNATURE_FLOATS),
    frame: -1,
    seenAt: 0,
    changedAt: 0,
    live: false,
    stale: false,
    fade: 0,
    anchor: -1,
    anchorX: 0,
    anchorY: 0,
    baked: new Float32Array(FIELD_MAX_MEMBERS * 4),
    bakedAt: -Infinity,
    settle: FIELD_SETTLE_MS,
    flapped: false,
    dirty: false,
    dirtyRect: new Float32Array(4),
    dirtyFade: 1,
    dirtyChangedAt: 0,
    dirtyBaked: false,
    refreshRect: new Float32Array(4),
    originX: 0,
    originY: 0,
    ratio: 1,
    textures: null,
    version: 0,
    bound: {
      source: null,
      version: -1,
      generation: -1,
      group: null as unknown as GPUBindGroup,
    },
  }
}

/** 创建一组给定尺寸的折射场纹理。内容在第一次写入时清空。 */
export function createFieldTextures(gpu: StageGpu, width: number, height: number): FieldTextures {
  const textures = FIELD_FORMATS.map(format => gpu.device.createTexture({
    size: { width, height },
    format,
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_DST,
  }))
  return {
    textures,
    views: textures.map(texture => texture.createView()),
    width,
    height,
  }
}

/** 半精度浮点数 -1 的位模式。 */
const HALF_MINUS_ONE = 0xBC00

/**
 * 创建一组 1 × 1 的空缓存：唯一的纹素标成“没有光路”。没有缓存纹理的组绑定它，
 * 读缓存的着色器在每个求交档像素上都回到逐步求交。
 */
export function createEmptyField(gpu: StageGpu): FieldTextures {
  const field = createFieldTextures(gpu, 1, 1)
  gpu.device.queue.writeTexture(
    { texture: field.textures[FIELD_FORMATS.length - 1]! },
    new Uint16Array([0, 0, 0, HALF_MINUS_ONE]),
    { bytesPerRow: 8 },
    { width: 1, height: 1 },
  )
  return field
}

/**
 * 缓存未命中时重建读取 `fields` 的纹理绑定：背景、各级模糊、查找表与折射场。
 * `generation` 是模糊与查找表的代数，与 `VolumeGroups` 里其余绑定的含义相同。
 */
export function bindFieldTextures(
  gpu: StageGpu,
  entry: FieldEntry,
  source: GPUTextureView,
  blurs: readonly GPUTextureView[],
  generation: number,
  lut: GPUTextureView,
  fields: FieldTextures,
): GPUBindGroup {
  const bound = entry.bound
  bound.source = source
  bound.version = entry.version
  bound.generation = generation
  bound.group = bindVolumeTextures(gpu, source, blurs, generation, lut, fields.views).group
  return bound.group
}
