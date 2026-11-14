import type { DrawItem, StageGpu } from '../gpu'
import type { BackdropBlur } from './blur'
import type { CoverRect } from './cover'
import type { VolumeSurface } from './fusion'
import { BLEND_NORMAL, blitPipeline, HEADER_FLOATS, RenderTarget, TARGET_FORMAT } from '../gpu'
import { glassVolumeRenderOrder } from '../render-order'
import { hexToLinear, srgbToLinear } from './color'
import { disjointCover } from './cover'
import { groupGlassSurfaces, pressedBox } from './fusion'
import { createVolumeShader, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from './volume-shader'

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

/** 一组相连的玻璃在本帧的几何与外观。 */
export interface VolumeGroupPlan {
  /** 组内成员，按表面编号排列。 */
  members: readonly VolumeSurface[]
  /** 包围矩形在视口中的范围，已裁剪到视口之内。 */
  bounds: CoverRect
  /** 绘制顺序。 */
  order: number
  /** 求交起点的高度。 */
  ceiling: number
  /** 平顶捷径要求其余成员保持的最小距离。 */
  reach: number
  /** 阴影的不透明度与延伸范围。 */
  shadowAlpha: number
  shadowSize: number
}

/** 降低着色分辨率时，一段连续层级的体积组共用的离屏目标。 */
interface VolumeBand {
  target: RenderTarget
  /** 本帧画进这个目标的体积组。 */
  items: DrawItem[]
}

/** 三维实体的半厚度：`refraction` 受控件短边限制。 */
export function volumeHalfDepth(surface: VolumeSurface): number {
  return Math.max(2, Math.min(surface.options.refraction, surface.width * 0.3, surface.height * 0.3))
}

/**
 * 按玻璃层级合并邻近实体，并算出每组的包围矩形、绘制顺序与求交范围。
 * 不依赖 GPU，可以直接测试。
 */
export function planVolumeGroups(surfaces: readonly VolumeSurface[], cssWidth: number, cssHeight: number): VolumeGroupPlan[] {
  return groupGlassSurfaces(surfaces).map((members) => {
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    let highest = 0
    let shadowAlpha = 0
    let shadowSize = 0
    let fusion = 0
    for (const member of members) {
      const options = member.options
      shadowAlpha = Math.max(shadowAlpha, options.shadow * member.opacity)
      shadowSize = Math.max(shadowSize, options.shadowSize)
      fusion = Math.max(fusion, options.fusion)
      const padding = Math.max(options.fusion, options.shadowSize) + 3
      left = Math.min(left, member.left - padding)
      top = Math.min(top, member.top - padding)
      right = Math.max(right, member.left + member.width + padding)
      bottom = Math.max(bottom, member.top + member.height + padding)
      highest = Math.max(highest, options.elevation + volumeHalfDepth(member) * 2 + options.fusion)
    }
    return {
      members,
      bounds: {
        left: Math.max(0, left),
        top: Math.max(0, top),
        right: Math.min(cssWidth, right),
        bottom: Math.min(cssHeight, bottom),
      },
      order: glassVolumeRenderOrder(members[0]!.options.layer, Math.max(...members.map(member => member.paintOrder))),
      ceiling: highest + 4,
      // 每一步平滑合并最多让距离减小半径的四分之一，按成员数量留出余量。
      reach: fusion * 2 * (1 + members.length / 4) + 1,
      shadowAlpha,
      shadowSize,
    }
  })
}

/** 把一组体积的参数写入 uniform，`start` 指向矩形与目标尺寸之后的位置。 */
export function writeVolumeGroup(data: Float32Array, start: number, group: VolumeGroupPlan): void {
  // 背景已经含有遮罩。仅压暗新增的染色与高光，玻璃覆盖率保持不变。
  const brightness = srgbToLinear(group.members[0]!.brightness)
  data[start] = group.ceiling
  data[start + 1] = group.reach
  data[start + 2] = brightness
  data[start + 4] = group.shadowAlpha
  data[start + 5] = group.shadowSize
  let offset = start + VOLUME_GROUP_FLOATS
  for (const member of group.members) {
    const options = member.options
    const tint = hexToLinear(options.tint)
    data.set(pressedBox(member), offset)
    data.set(options.radius, offset + 4)
    data[offset + 8] = volumeHalfDepth(member)
    data[offset + 9] = options.elevation
    data[offset + 10] = options.fusion
    data[offset + 11] = options.lens
    data.set(member.clip, offset + 12)
    data[offset + 16] = options.blur * options.blur
    data[offset + 17] = options.dispersion
    data[offset + 18] = options.tintAlpha
    data[offset + 19] = options.specular
    // 染色先乘染色比例再混合，通透一端不会把另一端的染色冲淡。
    data[offset + 20] = tint[0] * brightness * options.tintAlpha
    data[offset + 21] = tint[1] * brightness * options.tintAlpha
    data[offset + 22] = tint[2] * brightness * options.tintAlpha
    data[offset + 23] = member.opacity
    offset += VOLUME_MEMBER_FLOATS
  }
}

/**
 * 把体积组分成 `split` 之下与之上的两段，并算出每段放大回画布时使用的矩形。
 *
 * 离屏目标里各组已经相互混合，重叠的包围矩形要先换成互不重叠的矩形，否则重叠处的阴影会叠加两遍。
 * 每段的合成矩形使用段内最小的绘制顺序。
 */
export function planVolumeBands(groups: readonly VolumeGroupPlan[], split: number): { groups: VolumeGroupPlan[], cover: CoverRect[], order: number }[] {
  return [0, 1].map((index) => {
    const members = groups.filter(group => (group.order >= split
      ? 1
      : 0) === index)
    return {
      groups: members,
      cover: disjointCover(members.map(group => group.bounds)),
      order: Math.min(...members.map(group => group.order)),
    }
  })
}

/** 按玻璃层级合并邻近实体，并在每组中追踪三维折射光路。 */
export class VolumeGroups {
  private readonly gpu: StageGpu
  private readonly blur: BackdropBlur
  /** `split` 之下与之上的两段，首次降低分辨率时创建。 */
  private readonly bands: (VolumeBand | null)[] = [null, null]
  /** 背景与各级模糊的绑定，背景视图或模糊纹理变化时重建。 */
  private textures = new WeakMap<GPUTextureView, { generation: number, group: GPUBindGroup }>()

  constructor(gpu: StageGpu, blur: BackdropBlur) {
    this.gpu = gpu
    this.blur = blur
  }

  /** 在后台编译常见成员数量的管线，第一次出现融合时不必等待着色器编译。 */
  warm(counts: readonly number[]): void {
    for (const count of counts) {
      for (const format of [this.gpu.canvasFormat, TARGET_FORMAT])
        this.gpu.warm(volumeKey(count, format), volumeSpec(count, format))
    }
  }

  /**
   * 更新邻近关系，写入本帧的 uniform，返回画布遍中的绘制项。
   *
   * 管线只取决于成员数量并按数量缓存。按成员编号缓存会在滚动中不断遇到新组合，
   * 每次都要重新编译着色器，造成数十毫秒的单帧卡顿。
   *
   * 比例为 1 时体积直接画进画布。低于 1 时改画进低分辨率的离屏目标，再放大合成：
   * 玻璃后的背景本来就经过折射与模糊，降低分辨率主要让轮廓和高光略微变软，
   * 而页面文字和玻璃上的内容仍按画布分辨率绘制。
   *
   * 合成后一段内的所有体积先于这一段的内容绘制。被上层玻璃盖住的内容已由遮挡蒙版裁掉，
   * 差别只在于上层玻璃的阴影不再压暗下层玻璃上的文字。
   */
  plan(surfaces: readonly VolumeSurface[], source: GPUTextureView, shading: VolumeShading): DrawItem[] {
    for (const band of this.bands) {
      if (band)
        band.items = []
    }
    const groups = planVolumeGroups(surfaces, shading.cssWidth, shading.cssHeight)
    if (!groups.length)
      return []
    const textures = this.textureGroup(source)
    if (shading.scale >= 1) {
      return groups.map(group => this.item(group, textures, this.gpu.canvasFormat, shading, shading.pixelWidth, shading.pixelHeight))
    }

    const width = Math.max(1, Math.ceil(shading.pixelWidth * shading.scale))
    const height = Math.max(1, Math.ceil(shading.pixelHeight * shading.scale))
    const tile = blitPipeline(this.gpu, 'screen', this.gpu.canvasFormat)
    const items: DrawItem[] = []
    planVolumeBands(groups, shading.split).forEach((plan, index) => {
      if (!plan.groups.length)
        return
      const band = this.band(index)
      band.target.resize(width, height)
      band.items = plan.groups.map(group => this.item(group, textures, TARGET_FORMAT, shading, width, height))
      for (const rect of plan.cover) {
        const start = this.gpu.allocUniform(HEADER_FLOATS, {
          ...rect,
          targetWidth: shading.pixelWidth,
          targetHeight: shading.pixelHeight,
          cssWidth: shading.cssWidth,
          cssHeight: shading.cssHeight,
        })
        items.push({
          order: plan.order,
          pipeline: tile,
          uniform: start * 4,
          textures: band.target.group,
        })
      }
    })
    return items
  }

  /** 编码低分辨率的离屏绘制。目标清成全透明，体积按普通混合叠加后得到预乘颜色。 */
  encode(encoder: GPUCommandEncoder): void {
    for (const band of this.bands) {
      if (band?.items.length)
        this.gpu.encodePass(encoder, 'band', band.target, { r: 0, g: 0, b: 0, a: 0 }, band.items)
    }
  }

  /** 释放离屏目标。管线由 `StageGpu` 管理。 */
  dispose(): void {
    for (const band of this.bands)
      band?.target.dispose()
    this.bands.fill(null)
    this.textures = new WeakMap()
  }

  private item(
    group: VolumeGroupPlan,
    textures: GPUBindGroup,
    format: GPUTextureFormat,
    shading: VolumeShading,
    targetWidth: number,
    targetHeight: number,
  ): DrawItem {
    const count = group.members.length
    const start = this.gpu.allocUniform(HEADER_FLOATS + VOLUME_GROUP_FLOATS + count * VOLUME_MEMBER_FLOATS, {
      ...group.bounds,
      targetWidth,
      targetHeight,
      cssWidth: shading.cssWidth,
      cssHeight: shading.cssHeight,
    })
    writeVolumeGroup(this.gpu.arena.data, start + HEADER_FLOATS, group)
    return {
      order: group.order,
      pipeline: this.gpu.pipeline(volumeKey(count, format), volumeSpec(count, format)),
      uniform: start * 4,
      textures,
    }
  }

  private band(index: number): VolumeBand {
    const existing = this.bands[index]
    if (existing)
      return existing
    const band: VolumeBand = {
      target: new RenderTarget(this.gpu),
      items: [],
    }
    this.bands[index] = band
    return band
  }

  /** 背景在页面快照与合成背景之间切换（是否有内容遮挡），按背景视图分别缓存。 */
  private textureGroup(source: GPUTextureView): GPUBindGroup {
    const cached = this.textures.get(source)
    if (cached && cached.generation === this.blur.generation)
      return cached.group
    const group = this.gpu.textureGroupOf([source, ...this.blur.views])
    this.textures.set(source, { generation: this.blur.generation, group })
    return group
  }
}

function volumeKey(count: number, format: GPUTextureFormat): string {
  return `volume:${count}:${format}`
}

function volumeSpec(count: number, format: GPUTextureFormat) {
  return () => ({
    code: createVolumeShader(count),
    entry: 'volume',
    textures: VOLUME_TEXTURES,
    format,
    blend: BLEND_NORMAL,
  })
}
