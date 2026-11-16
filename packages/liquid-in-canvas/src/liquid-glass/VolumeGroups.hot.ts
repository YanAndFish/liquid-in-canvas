import type { DrawList, FrameEncoder } from '../frame.hot'
import type { PipelineTable, RenderTarget, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { BackdropBlur } from './blur.hot'
import type { CoverBuilder, CoverRect } from './cover.hot'
import type { FieldEntry } from './field-cache'
import type { FieldCache } from './field-cache.hot'
import type { GlassGroup, NumberSink, VolumeSurface } from './fusion.hot'
import type { ProfileTable } from './optics-lut'
import type { StackGroup, StackLevel } from './stack.hot'
import type { VolumeTextures } from './volume-shader'
import { CLEAR_TRANSPARENT, HEADER_FLOATS } from '../frame'
import { SLOT_CANVAS, SLOT_TARGET } from '../gpu'
import { glassVolumeRenderOrder } from '../render-order'
import { linearTint, srgbToLinear } from './color'
import { bindFieldTextures } from './field-cache'
import { GlassGroups, writePressedBox } from './fusion.hot'
import { createFieldCache, createProfileTable, createStackLevels, createVolumeBands, createVolumePlan, growInt32 } from './pools'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from './profile'
import { assignStackLevels, MAX_STACK_LEVELS, stackMargin } from './stack.hot'
import { HYBRID_CLIP_PAD, hybridLateral } from './volume-hybrid-shader'
import { memberCornered, writeFusionProximity } from './volume-members.hot'
import { bindVolumeTextures, createFieldBakePipelines, createVolumePipelines, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from './volume-shader'

/** 体积着色的分辨率设置。 */
export interface VolumeShading {
  /** 着色分辨率相对画布的比例，1 表示直接画进画布。 */
  scale: number
  /** 画布的像素尺寸。 */
  pixelWidth: number
  pixelHeight: number
  /** 视口的 CSS 尺寸。 */
  cssWidth: number
  cssHeight: number
  /** 画布遍中插在玻璃之间的其他内容的绘制顺序，低分辨率合成在这里分段。 */
  split: number
}

/** 一组相连的玻璃在本帧的几何与外观。对象在 `VolumePlanner` 里复用。 */
export interface VolumeGroupPlan extends StackGroup {
  /** 组内成员，按表面编号排列，前 `count` 项有效。 */
  members: VolumeSurface[]
  count: number
  /** 包围矩形在视口中的范围，已裁剪到视口之内。 */
  readonly bounds: CoverRect
  /** 绘制顺序。 */
  order: number
  /** 玻璃层级。 */
  layer: number
  /** 成员中最大的模糊方差。 */
  variance: number
  /** 折射与反射取样可能到达的、轮廓之外的距离。 */
  margin: number
  /** 求交起点的高度。 */
  ceiling: number
  /** 平顶捷径要求其余成员保持的最小距离。 */
  reach: number
  /** 混合光路里其余成员不参与平滑合并的最小距离，比 `reach` 紧。 */
  apart: number
  /** 阴影的不透明度与延伸范围。 */
  shadowAlpha: number
  shadowSize: number
}

/** 降低着色分辨率时，一段连续层级的体积组共用的离屏目标。 */
export interface VolumeBand {
  target: RenderTarget
  /** 本帧画进这个目标的体积组。 */
  list: DrawList
  /** 段内各组的包围矩形，前 `rectCount` 项有效。 */
  rects: CoverRect[]
  rectCount: number
  /** 把包围矩形换成互不重叠的合成矩形。 */
  cover: CoverBuilder
}

/** 嵌套玻璃的组排在外层所在组之后的间隔，远小于同层两块玻璃之间的顺序差。 */
const NESTED_ORDER_STEP = 0.0001

/** 材质化程度，限制在出现时可能越过的范围内。 */
function materialized(surface: VolumeSurface): number {
  return Math.min(1.3, Math.max(0, surface.materialize))
}

/** 不超过 1 的材质化程度，用于模糊、染色、高光与阴影这些不应越过原值的量。 */
function settled(surface: VolumeSurface): number {
  return Math.min(1, materialized(surface))
}

/**
 * 三维实体的半厚度：`refraction` 受控件短边限制，材质化时从接近零长到原厚度
 * （出现时略微越过，先厚后回落）。
 */
export function volumeHalfDepth(surface: VolumeSurface): number {
  const base = profileHalfDepth(surface.options.refraction, surface.width, surface.height)
  return Math.max(0.5, base * materialized(surface))
}

/** 算出一组的包围矩形、绘制顺序与求交范围。 */
function planGroup(plan: VolumeGroupPlan, group: GlassGroup, cssWidth: number, cssHeight: number): void {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let bodyLeft = Infinity
  let bodyTop = Infinity
  let bodyRight = -Infinity
  let bodyBottom = -Infinity
  let highest = 0
  let shadowAlpha = 0
  let shadowSize = 0
  let fusion = 0
  let variance = 0
  let margin = 0
  let paintOrder = -Infinity
  const members = group.members
  for (let i = 0; i < group.count; i++) {
    const member = members[i]!
    const options = member.options
    const halfDepth = volumeHalfDepth(member)
    const amount = settled(member)
    shadowAlpha = Math.max(shadowAlpha, options.shadow * member.opacity * amount)
    shadowSize = Math.max(shadowSize, options.shadowSize)
    fusion = Math.max(fusion, member.fusion)
    variance = Math.max(variance, options.blur * options.blur * amount * amount)
    margin = Math.max(margin, stackMargin(halfDepth, options.elevation))
    paintOrder = Math.max(paintOrder, member.paintOrder)
    const padding = Math.max(member.fusion, options.shadowSize) + 3
    left = Math.min(left, member.left - padding)
    top = Math.min(top, member.top - padding)
    right = Math.max(right, member.left + member.width + padding)
    bottom = Math.max(bottom, member.top + member.height + padding)
    bodyLeft = Math.min(bodyLeft, member.left)
    bodyTop = Math.min(bodyTop, member.top)
    bodyRight = Math.max(bodyRight, member.left + member.width)
    bodyBottom = Math.max(bodyBottom, member.top + member.height)
    highest = Math.max(highest, options.elevation + halfDepth * 2 + member.fusion)
  }
  plan.members = members
  plan.count = group.count
  plan.bounds.left = Math.max(0, left)
  plan.bounds.top = Math.max(0, top)
  plan.bounds.right = Math.min(cssWidth, right)
  plan.bounds.bottom = Math.min(cssHeight, bottom)
  plan.body.left = bodyLeft
  plan.body.top = bodyTop
  plan.body.right = bodyRight
  plan.body.bottom = bodyBottom
  plan.layer = members[0]!.layer
  plan.order = glassVolumeRenderOrder(plan.layer, paintOrder)
  plan.ceiling = highest + 4
  // 每一步平滑合并最多让距离减小半径的四分之一，按成员数量留出余量。
  plan.reach = fusion * 2 * (1 + group.count / 4) + 1
  // 只有一名成员靠近时：它与其余成员合并的半径不超过 2 × 融合距离；排在它之前的成员之间
  // 最多合并 count − 2 次，每次让距离减小不超过半径的四分之一。
  plan.apart = fusion * 2 * (1 + Math.max(0, group.count - 2) / 4) + 1
  plan.shadowAlpha = shadowAlpha
  plan.shadowSize = shadowSize
  plan.variance = variance
  plan.margin = margin
}

/**
 * 按玻璃层级合并邻近实体，并算出每组的包围矩形、绘制顺序与求交范围。
 * 不依赖 GPU，可以直接测试。结果写进 `plans` 的前 `count` 项。
 */
export class VolumePlanner {
  readonly plans: VolumeGroupPlan[] = []
  count = 0
  /** 各级背景本帧的范围与模糊需求，见 `stack.hot.ts`。 */
  readonly levels: StackLevel[] = createStackLevels()
  private readonly groups = new GlassGroups()
  private sorted = new Int32Array(32)

  build(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number): void {
    const groups = this.groups
    groups.build(surfaces, count)
    for (let i = 0; i < groups.count; i++)
      planGroup(this.plans[i] ?? this.grow(i), groups.groups[i]!, cssWidth, cssHeight)
    this.count = groups.count
    for (let i = 0; i < this.count; i++)
      this.followHost(this.plans[i]!)
    if (this.sorted.length < this.count)
      this.sorted = growInt32(this.count)
    assignStackLevels(this.plans, this.count, this.sorted, this.levels, cssWidth, cssHeight)
  }

  /** 包含这块体积的组；本帧没有分组时为 null。 */
  planOf(surface: VolumeSurface): VolumeGroupPlan | null {
    for (let i = 0; i < this.count; i++) {
      const plan = this.plans[i]!
      for (let j = 0; j < plan.count; j++) {
        if (plan.members[j] === surface)
          return plan
      }
    }
    return null
  }

  /**
   * 嵌套玻璃紧跟在外层所在的组之后绘制。
   *
   * 组的顺序取成员中最靠后的 HTML 绘制顺序。外层与 HTML 里更靠后的玻璃（例如拖到旁边的悬浮按钮）
   * 融合后，外层所在的组会排到嵌套玻璃之后，把嵌套玻璃整个盖住。
   */
  private followHost(plan: VolumeGroupPlan): void {
    const host = plan.members[0]!.host
    if (host === null)
      return
    for (let i = 0; i < this.count; i++) {
      const other = this.plans[i]!
      for (let j = 0; j < other.count; j++) {
        if (other.members[j]!.id === host) {
          plan.order = Math.max(plan.order, other.order + NESTED_ORDER_STEP)
          return
        }
      }
    }
  }

  private grow(index: number): VolumeGroupPlan {
    const plan = createVolumePlan()
    this.plans[index] = plan
    return plan
  }
}

/**
 * 把一组体积的参数写入 uniform，`start` 指向矩形与目标尺寸之后的位置。
 * 传入 `profiles` 时同时写入每名成员的剖面查找表行号（剖面光学与混合光路）。
 *
 * 返回混合光路是否要对这一组逐像素判断（成员只有一名时）：
 * - 裁剪范围切进了某名成员：裁剪边到玻璃的距离小于光线在玻璃内可能的横向位移加半厚度时，裁剪会改变光路；
 * - 某名成员的圆角比倒角窄：拐角里有一带距离场不是到轮廓的真实距离，查表与求交的结果不同（见 `glass_corner`）。
 * 没有传入 `profiles` 时不判断，返回 false。
 */
export function writeVolumeGroup(data: NumberSink, start: number, plan: VolumeGroupPlan, profiles: ProfileTable | null = null): boolean {
  // 背景已经含有遮罩。仅压暗新增的染色与高光，玻璃覆盖率保持不变。
  const brightness = srgbToLinear(plan.members[0]!.brightness)
  data[start] = plan.ceiling
  data[start + 1] = plan.reach
  data[start + 2] = brightness
  data[start + 3] = plan.apart
  data[start + 4] = plan.shadowAlpha
  data[start + 5] = plan.shadowSize
  const valid = plan.valid
  data[start + 8] = valid.left
  data[start + 9] = valid.top
  data[start + 10] = valid.right
  data[start + 11] = valid.bottom
  let offset = start + VOLUME_GROUP_FLOATS
  let cut = false
  for (let i = 0; i < plan.count; i++) {
    const member = plan.members[i]!
    const options = member.options
    const tint = linearTint(options.tint)
    const radius = options.radius
    const clip = member.clip
    writePressedBox(data, offset, member)
    data[offset + 4] = radius[0]
    data[offset + 5] = radius[1]
    data[offset + 6] = radius[2]
    data[offset + 7] = radius[3]
    const halfDepth = volumeHalfDepth(member)
    const amount = settled(member)
    const tintAlpha = options.tintAlpha * amount
    data[offset + 8] = halfDepth
    data[offset + 9] = options.elevation
    data[offset + 10] = member.fusion
    data[offset + 11] = Math.min(0.6, options.lens * materialized(member))
    data[offset + 12] = clip[0]!
    data[offset + 13] = clip[1]!
    data[offset + 14] = clip[2]!
    data[offset + 15] = clip[3]!
    data[offset + 16] = options.blur * options.blur * amount * amount
    data[offset + 17] = options.dispersion
    data[offset + 18] = tintAlpha
    data[offset + 19] = options.specular * amount
    // 染色先乘染色比例再混合，通透一端不会把另一端的染色冲淡。
    data[offset + 20] = tint[0] * brightness * tintAlpha
    data[offset + 21] = tint[1] * brightness * tintAlpha
    data[offset + 22] = tint[2] * brightness * tintAlpha
    // 材质化接近零时整块淡出，此前已经几乎没有折射与磨砂。
    data[offset + 23] = member.opacity * Math.min(1, materialized(member) * 3)
    // 倒角宽度在着色器里再按按压后的尺寸限制。
    data[offset + 24] = profileBevelWidth(halfDepth, options.bevelWidth)
    data[offset + 25] = profileBevelHeight(halfDepth, options.bevelHeight)
    data[offset + 26] = options.bevelCurve
    data[offset + 27] = options.bottomBevel
    data[offset + 29] = 1 + (options.saturation - 1) * amount
    data[offset + 30] = 1 + (options.brightness - 1) * amount
    if (profiles) {
      // 与着色器一致：倒角宽度不超过按压后的半宽高，也不小于半个像素。
      const bevelWidth = Math.max(Math.min(data[offset + 24]!, data[offset + 2]!, data[offset + 3]!), 0.5)
      const row = profiles.rowOf(bevelWidth / halfDepth, data[offset + 25]! / halfDepth, options.bevelCurve, options.bottomBevel, options.dispersion)
      data[offset + 28] = row
      // 与混合着色器的查表条件一致，横向位移取这一行的最大值。
      const pad = hybridLateral(profiles.reachOf(row), halfDepth) + halfDepth + HYBRID_CLIP_PAD
      const x = data[offset]!
      const y = data[offset + 1]!
      const halfWidth = data[offset + 2]!
      const halfHeight = data[offset + 3]!
      cut ||= clip[0]! > x - halfWidth - pad || clip[1]! > y - halfHeight - pad || clip[2]! < x + halfWidth + pad || clip[3]! < y + halfHeight + pad
      cut ||= memberCornered(data, offset)
    }
    offset += VOLUME_MEMBER_FLOATS
  }
  writeFusionProximity(data, start + VOLUME_GROUP_FLOATS, plan.count)
  return cut
}

/** 按玻璃层级合并邻近实体，并在每组中追踪三维折射光路。 */
export class VolumeGroups {
  private readonly gpu: StageGpu
  private readonly frame: FrameEncoder
  /** 各级背景的模糊，下标是背景级别。 */
  private readonly blurs: readonly BackdropBlur[]
  /** 各级背景本帧的纹理视图，下标是背景级别。 */
  private readonly sources: (GPUTextureView | null)[] = []
  private readonly planner = new VolumePlanner()
  /**
   * 体积管线按成员数量缓存，分别对应画布与离屏目标的格式。按成员编号缓存会在滚动中不断遇到新组合，
   * 每次都要重新编译着色器，造成数十毫秒的单帧卡顿。
   */
  private readonly pipelines: PipelineTable[]
  /** 剖面光学的管线；混合光路里只有一名成员、裁剪没有切进玻璃、圆角也不比倒角窄的组也用它。 */
  private readonly profilePipelines: PipelineTable[]
  /** 混合光路的管线：逐像素在查表与求交之间选择，用于多名成员的组、被裁剪切开的组与圆角比倒角窄的玻璃。 */
  private readonly hybridPipelines: PipelineTable[]
  /** 读取折射场缓存的混合管线：几何静止的组求交一次之后用它。 */
  private readonly fieldPipelines: PipelineTable[]
  /** 写入折射场缓存的管线。 */
  private readonly bakePipelines: PipelineTable
  /** 剖面光学与混合光路的查找表，第一次切换到这两种光路时创建。 */
  private profiles: ProfileTable | null = null
  /** 混合光路的折射场缓存，第一次以混合光路绘制时创建；关闭缓存或换成别的光路时为 null。 */
  private fields: FieldCache | null = null
  /** 已经创建的缓存对象，关闭后保留，再打开时复用。 */
  private fieldStore: FieldCache | null = null
  private fieldCache = true
  private optics: GlassOptics = 'raymarch'
  /** `split` 之下与之上的两段。 */
  private readonly bands: VolumeBand[]
  /** 背景与各级模糊的绑定，按背景视图缓存；第 0 级的背景在页面快照与合成背景之间切换。 */
  private readonly textures = new WeakMap<GPUTextureView, VolumeTextures>()
  /** 剖面光学的绑定，另外包含查找表。 */
  private readonly profileTextures = new WeakMap<GPUTextureView, VolumeTextures>()

  /** `blurs` 的下标是背景级别，第 0 级必须提供；没有更高级的模糊时那些级别不会被使用。 */
  constructor(gpu: StageGpu, blurs: readonly BackdropBlur[]) {
    this.gpu = gpu
    this.frame = gpu.frame
    this.blurs = blurs
    for (let i = 0; i < MAX_STACK_LEVELS; i++)
      this.sources.push(null)
    // 管线表只是空表，着色器在第一次取用或预热时才编译。
    this.pipelines = createVolumePipelines(gpu)
    this.profilePipelines = createVolumePipelines(gpu, 'profile')
    this.hybridPipelines = createVolumePipelines(gpu, 'hybrid')
    this.fieldPipelines = createVolumePipelines(gpu, 'field')
    this.bakePipelines = createFieldBakePipelines(gpu)
    this.bands = createVolumeBands(gpu)
  }

  /** 本帧的分组与背景分级，`group()` 之后有效。 */
  get groups(): VolumePlanner {
    return this.planner
  }

  /**
   * 折射场缓存是否还在过渡：有组在等待静止后求交，或求交结果正在淡入淡出。
   * 为 true 时即使页面没有变化也要再画一帧，否则停下之后画面会停在查表的近似上。
   */
  get settling(): boolean {
    return this.fields !== null && this.fields.settling
  }

  /** 在后台编译常见成员数量的管线，第一次出现融合时不必等待着色器编译。 */
  warm(counts: readonly number[]): void {
    const optics = this.optics
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i]!
      // 混合光路里只有一名成员的组通常用剖面管线，被裁剪切开或圆角比倒角窄时才用混合管线，两条都预热。
      if (optics === 'hybrid' && count === 1) {
        this.profilePipelines[SLOT_CANVAS]!.warm(count)
        this.profilePipelines[SLOT_TARGET]!.warm(count)
      }
      const pipelines = this.table(true)
      pipelines[SLOT_CANVAS]!.warm(count)
      pipelines[SLOT_TARGET]!.warm(count)
      // 打开缓存时，融合的组运动中用剖面管线，静止后用写入与读取缓存的管线。
      if (optics === 'hybrid' && this.fieldCache) {
        this.profilePipelines[SLOT_CANVAS]!.warm(count)
        this.profilePipelines[SLOT_TARGET]!.warm(count)
        this.fieldPipelines[SLOT_CANVAS]!.warm(count)
        this.fieldPipelines[SLOT_TARGET]!.warm(count)
        this.bakePipelines.warm(count)
      }
    }
  }

  /** 切换光路计算方式。第一次切到剖面光学或混合光路时创建查找表。 */
  setOptics(optics: GlassOptics): void {
    if (optics === this.optics)
      return
    this.optics = optics
    if (optics !== 'raymarch' && !this.profiles)
      this.profiles = createProfileTable(this.gpu)
    this.selectFields()
  }

  /**
   * 打开或关闭混合光路的折射场缓存，缺省打开。关闭后融合的组、被裁剪切开与圆角比倒角窄的玻璃每帧逐步求交，
   * 运动时也不改用查表。
   */
  setFieldCache(enabled: boolean): void {
    if (enabled === this.fieldCache)
      return
    this.fieldCache = enabled
    this.selectFields()
  }

  /**
   * 按层级与邻近关系分组，并为每组分配背景级别。`now` 是当前时间（毫秒），
   * 折射场缓存用它判断几何静止了多久。
   */
  group(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number, now = performance.now()): void {
    // 上一帧扩容换下的查找表纹理已随那一帧提交，可以释放。
    this.profiles?.release()
    this.fields?.begin(now)
    this.planner.build(surfaces, count, cssWidth, cssHeight)
  }

  /** 设置第 `level` 级背景本帧的纹理视图。 */
  setSource(level: number, view: GPUTextureView): void {
    this.sources[level] = view
  }

  /** 分组、设置第 0 级背景并安排绘制，等同于依次调用 `group()`、`setSource()` 与 `draw()`。 */
  plan(surfaces: readonly VolumeSurface[], count: number, source: GPUTextureView, shading: VolumeShading, canvas: DrawList, now = performance.now()): void {
    this.group(surfaces, count, shading.cssWidth, shading.cssHeight, now)
    this.setSource(0, source)
    this.draw(shading, canvas)
  }

  /**
   * 写入本帧的 uniform，把画布遍中的绘制项加入 `canvas`。每组取样自己那一级的背景。
   *
   * 比例为 1 时体积直接画进画布。低于 1 时改画进低分辨率的离屏目标，再放大合成：
   * 玻璃后的背景本来就经过折射与模糊，降低分辨率主要让轮廓和高光略微变软，
   * 而页面文字和玻璃上的内容仍按画布分辨率绘制。
   *
   * 合成后一段内的所有体积先于这一段的内容绘制。被上层玻璃盖住的内容已由遮挡蒙版裁掉，
   * 差别只在于上层玻璃的阴影不再压暗下层玻璃上的文字。
   */
  draw(shading: VolumeShading, canvas: DrawList): void {
    const bands = this.bands
    bands[0]!.list.reset()
    bands[1]!.list.reset()
    const planner = this.planner
    if (planner.count === 0)
      return
    if (shading.scale >= 1) {
      for (let i = 0; i < planner.count; i++) {
        const bounds = planner.plans[i]!.bounds
        this.push(canvas, SLOT_CANVAS, planner.plans[i]!, bounds.left, bounds.top, bounds.right, bounds.bottom, shading.cssWidth, shading.cssHeight, shading.pixelWidth, shading.pixelHeight, true)
      }
      return
    }

    const width = Math.max(1, Math.ceil(shading.pixelWidth * shading.scale))
    const height = Math.max(1, Math.ceil(shading.pixelHeight * shading.scale))
    const tile = this.gpu.blitScreen.get(SLOT_CANVAS)
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index]!
      band.rectCount = 0
      let order = Infinity
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        const bandIndex = plan.order >= shading.split
          ? 1
          : 0
        if (bandIndex !== index)
          continue
        band.rects[band.rectCount++] = plan.bounds
        order = Math.min(order, plan.order)
      }
      if (band.rectCount === 0)
        continue
      band.target.resize(width, height)
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        if ((plan.order >= shading.split
          ? 1
          : 0) === index) {
          const bounds = plan.bounds
          this.push(band.list, SLOT_TARGET, plan, bounds.left, bounds.top, bounds.right, bounds.bottom, shading.cssWidth, shading.cssHeight, width, height, true)
        }
      }
      // 离屏目标里各组已经相互混合，重叠的包围矩形要先换成互不重叠的矩形，否则重叠处的阴影会叠加两遍。
      const cover = band.cover
      cover.build(band.rects, band.rectCount)
      for (let i = 0; i < cover.count; i++) {
        const rect = cover.rects[i]!
        const start = this.frame.rect(
          HEADER_FLOATS,
          rect.left,
          rect.top,
          rect.right,
          rect.bottom,
          shading.cssWidth,
          shading.cssHeight,
          shading.pixelWidth,
          shading.pixelHeight,
        )
        canvas.push(order, tile, start * 4, band.target.group)
      }
    }
  }

  /** 把一组体积画进离屏背景（CSS 分辨率）。组取样自己那一级的背景。 */
  drawInto(list: DrawList, plan: VolumeGroupPlan, limit: CoverRect, cssWidth: number, cssHeight: number, targetWidth: number, targetHeight: number): void {
    const bounds = plan.bounds
    const left = Math.max(bounds.left, limit.left)
    const top = Math.max(bounds.top, limit.top)
    const right = Math.min(bounds.right, limit.right)
    const bottom = Math.min(bounds.bottom, limit.bottom)
    if (right <= left || bottom <= top)
      return
    this.push(list, SLOT_TARGET, plan, left, top, right, bottom, cssWidth, cssHeight, targetWidth, targetHeight, false)
  }

  /**
   * 编码折射场缓存的写入与低分辨率的离屏绘制。离屏目标清成全透明，体积按普通混合叠加后得到预乘颜色。
   * 本帧写入的缓存只被本帧的主绘制读取（画布遍或下面的离屏遍），所以排在各级背景之后也没有问题。
   */
  encode(encoder: GPUCommandEncoder): void {
    this.fields?.encode(encoder)
    for (let i = 0; i < this.bands.length; i++) {
      const band = this.bands[i]!
      if (band.list.count > 0)
        this.frame.encodePass(encoder, 'band', band.target.view, band.target.width, band.target.height, CLEAR_TRANSPARENT, band.list)
    }
  }

  /** 释放离屏目标与查找表。管线由 `StageGpu` 编译，随设备释放。 */
  dispose(): void {
    for (const band of this.bands)
      band.target.dispose()
    this.profiles?.dispose()
    this.fieldStore?.dispose()
    this.fields = null
    this.fieldStore = null
  }

  /** 按当前光路与开关决定是否使用折射场缓存；不再使用时放弃已有的缓存。 */
  private selectFields(): void {
    if (this.optics === 'hybrid' && this.fieldCache) {
      this.fieldStore ??= createFieldCache(this.gpu)
      this.fields = this.fieldStore
      return
    }
    this.fields?.reset()
    this.fields = null
  }

  /**
   * 一组体积使用的管线表。`traced` 表示这一组在混合光路下需要逐像素判断是否求交：
   * 成员多于一名、裁剪范围切进了玻璃，或圆角比倒角窄；其余的组与剖面光学一样只查表。
   */
  private table(traced: boolean): PipelineTable[] {
    const optics = this.optics
    if (optics === 'raymarch')
      return this.pipelines
    return optics === 'hybrid' && traced
      ? this.hybridPipelines
      : this.profilePipelines
  }

  /**
   * 写入一组体积的 uniform，按这一组的情况选管线，把绘制项加入 `list`。只绘制给定矩形（CSS 像素）。
   *
   * `primary` 表示这是这一组在画面里的主绘制（画布或低分辨率的离屏目标），折射场缓存按它的分辨率写入；
   * 画进上层背景的那一次只读取已有的缓存。
   */
  private push(
    list: DrawList,
    slot: number,
    plan: VolumeGroupPlan,
    left: number,
    top: number,
    right: number,
    bottom: number,
    cssWidth: number,
    cssHeight: number,
    targetWidth: number,
    targetHeight: number,
    primary: boolean,
  ): void {
    const start = this.frame.rect(
      HEADER_FLOATS + VOLUME_GROUP_FLOATS + plan.count * VOLUME_MEMBER_FLOATS,
      left,
      top,
      right,
      bottom,
      cssWidth,
      cssHeight,
      targetWidth,
      targetHeight,
    )
    // 三维求交不读查找表，其余两种光路都要写行号。
    const profiles = this.optics === 'raymarch'
      ? null
      : this.profiles
    const group = start + HEADER_FLOATS
    const traced = writeVolumeGroup(this.frame.data, group, plan, profiles) || plan.count > 1
    let pipelines = this.table(traced)
    let textures: GPUBindGroup | null = null
    const fields = this.fields
    if (fields !== null && profiles !== null && traced) {
      const entry = fields.track(plan, this.frame.data, group, profiles)
      if (entry !== null) {
        if (primary && fields.prepare(entry, this.frame.data, group, plan.count, profiles, targetWidth / cssWidth))
          this.bake(fields, entry, plan, start, targetWidth, targetHeight, cssWidth, cssHeight)
        if (entry.live || entry.fade > 0) {
          // 静止的组读缓存；刚开始运动的组把上一次的求交结果淡出。
          // 纹素按像素坐标查找：纹素 = 像素 × (缓存倍率 / 目标倍率) − 缓存左上角（纹素）。主绘制里比例为 1，逐像素对齐。
          const data = this.frame.data
          data[group + 12] = Math.round((entry.anchorX + entry.originX) * entry.ratio)
          data[group + 13] = Math.round((entry.anchorY + entry.originY) * entry.ratio)
          data[group + 14] = entry.ratio * cssWidth / targetWidth
          data[group + 15] = entry.fade
          pipelines = this.fieldPipelines
          textures = this.fieldGroup(fields, entry, plan.level)
        }
        else {
          // 运动中的组查表：连接处是近似，停下之后再求交。
          pipelines = this.profilePipelines
        }
      }
    }
    list.push(plan.order, pipelines[slot]!.get(plan.count), start * 4, textures ?? this.textureGroup(plan.level))
  }

  /**
   * 安排把一组的折射场写进缓存：复制这一组刚写好的 uniform，目标换成缓存纹理。
   *
   * 成员仍用视口坐标，`screen` 仍是这一组主绘制的目标尺寸，片元坐标加上缓存左上角的像素位置：
   * 每个纹素求交时的坐标与画面上对应像素的计算逐位相同。轮廓附近全内反射的光路对坐标的舍入很敏感，
   * 换成局部坐标会让这些像素与逐帧求交的结果不同。`source` 是这一组的 uniform 在本帧数据里的起始下标。
   */
  private bake(
    fields: FieldCache,
    entry: FieldEntry,
    plan: VolumeGroupPlan,
    source: number,
    targetWidth: number,
    targetHeight: number,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const target = entry.textures!
    const floats = HEADER_FLOATS + VOLUME_GROUP_FLOATS + plan.count * VOLUME_MEMBER_FLOATS
    const start = this.frame.rect(floats, 0, 0, 1, 1, 1, 1, target.width, target.height)
    // 分配可能换了一块更大的数组，原来的内容保留在同样的下标上。
    const data = this.frame.data
    data.copyWithin(start + HEADER_FLOATS, source + HEADER_FLOATS, source + floats)
    data[start + 4] = targetWidth
    data[start + 5] = targetHeight
    data[start + 6] = cssWidth
    data[start + 7] = cssHeight
    const group = start + HEADER_FLOATS
    data[group + 12] = Math.round((entry.anchorX + entry.originX) * entry.ratio)
    data[group + 13] = Math.round((entry.anchorY + entry.originY) * entry.ratio)
    fields.list.push(0, this.bakePipelines.get(plan.count), start * 4, this.textureGroup(plan.level))
  }

  /** 读取一组折射场缓存的纹理绑定：背景、各级模糊、查找表与折射场，按条目缓存。 */
  private fieldGroup(fields: FieldCache, entry: FieldEntry, level: number): GPUBindGroup {
    const source = this.sources[level] ?? this.sources[0]!
    const blur = this.blurs[level] ?? this.blurs[0]!
    const profiles = this.profiles!
    const generation = blur.generation * 65536 + profiles.generation
    const bound = entry.bound
    if (bound.source === source && bound.generation === generation && bound.version === entry.version)
      return bound.group
    return bindFieldTextures(this.gpu, entry, source, blur.views, generation, profiles.view, fields.texturesOf(entry))
  }

  private textureGroup(level: number): GPUBindGroup {
    const source = this.sources[level] ?? this.sources[0]!
    const blur = this.blurs[level] ?? this.blurs[0]!
    const profiles = this.optics === 'raymarch'
      ? null
      : this.profiles
    if (profiles) {
      // 查找表与模糊的代数合成一个数：任意一方重建纹理都会让缓存失效。
      const generation = blur.generation * 65536 + profiles.generation
      const cached = this.profileTextures.get(source)
      if (cached && cached.generation === generation)
        return cached.group
      const bound = bindVolumeTextures(this.gpu, source, blur.views, generation, profiles.view)
      this.profileTextures.set(source, bound)
      return bound.group
    }
    const cached = this.textures.get(source)
    if (cached && cached.generation === blur.generation)
      return cached.group
    const bound = bindVolumeTextures(this.gpu, source, blur.views, blur.generation)
    this.textures.set(source, bound)
    return bound.group
  }
}
