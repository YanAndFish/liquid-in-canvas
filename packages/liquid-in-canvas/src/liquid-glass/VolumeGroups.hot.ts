import type { DrawList, FrameEncoder } from '../frame.hot'
import type { PipelineTable, RenderTarget, StageGpu } from '../gpu'
import type { BackdropBlur } from './blur.hot'
import type { CoverBuilder, CoverRect } from './cover.hot'
import type { GlassGroup, NumberSink, VolumeSurface } from './fusion.hot'
import type { VolumeTextures } from './volume-shader'
import { CLEAR_TRANSPARENT, HEADER_FLOATS } from '../frame'
import { SLOT_CANVAS, SLOT_TARGET } from '../gpu'
import { glassVolumeRenderOrder } from '../render-order'
import { linearTint, srgbToLinear } from './color'
import { GlassGroups, writePressedBox } from './fusion.hot'
import { createVolumeBands, createVolumePlan } from './pools'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from './profile'
import { bindVolumeTextures, createVolumePipelines, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from './volume-shader'

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
export interface VolumeGroupPlan {
  /** 组内成员，按表面编号排列，前 `count` 项有效。 */
  members: VolumeSurface[]
  count: number
  /** 包围矩形在视口中的范围，已裁剪到视口之内。 */
  readonly bounds: CoverRect
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

/** 三维实体的半厚度：`refraction` 受控件短边限制。 */
export function volumeHalfDepth(surface: VolumeSurface): number {
  return profileHalfDepth(surface.options.refraction, surface.width, surface.height)
}

/** 算出一组的包围矩形、绘制顺序与求交范围。 */
function planGroup(plan: VolumeGroupPlan, group: GlassGroup, cssWidth: number, cssHeight: number): void {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let highest = 0
  let shadowAlpha = 0
  let shadowSize = 0
  let fusion = 0
  let paintOrder = -Infinity
  const members = group.members
  for (let i = 0; i < group.count; i++) {
    const member = members[i]!
    const options = member.options
    shadowAlpha = Math.max(shadowAlpha, options.shadow * member.opacity)
    shadowSize = Math.max(shadowSize, options.shadowSize)
    fusion = Math.max(fusion, member.fusion)
    paintOrder = Math.max(paintOrder, member.paintOrder)
    const padding = Math.max(member.fusion, options.shadowSize) + 3
    left = Math.min(left, member.left - padding)
    top = Math.min(top, member.top - padding)
    right = Math.max(right, member.left + member.width + padding)
    bottom = Math.max(bottom, member.top + member.height + padding)
    highest = Math.max(highest, options.elevation + volumeHalfDepth(member) * 2 + member.fusion)
  }
  plan.members = members
  plan.count = group.count
  plan.bounds.left = Math.max(0, left)
  plan.bounds.top = Math.max(0, top)
  plan.bounds.right = Math.min(cssWidth, right)
  plan.bounds.bottom = Math.min(cssHeight, bottom)
  plan.order = glassVolumeRenderOrder(members[0]!.layer, paintOrder)
  plan.ceiling = highest + 4
  // 每一步平滑合并最多让距离减小半径的四分之一，按成员数量留出余量。
  plan.reach = fusion * 2 * (1 + group.count / 4) + 1
  plan.shadowAlpha = shadowAlpha
  plan.shadowSize = shadowSize
}

/**
 * 按玻璃层级合并邻近实体，并算出每组的包围矩形、绘制顺序与求交范围。
 * 不依赖 GPU，可以直接测试。结果写进 `plans` 的前 `count` 项。
 */
export class VolumePlanner {
  readonly plans: VolumeGroupPlan[] = []
  count = 0
  private readonly groups = new GlassGroups()

  build(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number): void {
    const groups = this.groups
    groups.build(surfaces, count)
    for (let i = 0; i < groups.count; i++)
      planGroup(this.plans[i] ?? this.grow(i), groups.groups[i]!, cssWidth, cssHeight)
    this.count = groups.count
    for (let i = 0; i < this.count; i++)
      this.followHost(this.plans[i]!)
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

/** 把一组体积的参数写入 uniform，`start` 指向矩形与目标尺寸之后的位置。 */
export function writeVolumeGroup(data: NumberSink, start: number, plan: VolumeGroupPlan): void {
  // 背景已经含有遮罩。仅压暗新增的染色与高光，玻璃覆盖率保持不变。
  const brightness = srgbToLinear(plan.members[0]!.brightness)
  data[start] = plan.ceiling
  data[start + 1] = plan.reach
  data[start + 2] = brightness
  data[start + 4] = plan.shadowAlpha
  data[start + 5] = plan.shadowSize
  let offset = start + VOLUME_GROUP_FLOATS
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
    data[offset + 8] = halfDepth
    data[offset + 9] = options.elevation
    data[offset + 10] = member.fusion
    data[offset + 11] = options.lens
    data[offset + 12] = clip[0]!
    data[offset + 13] = clip[1]!
    data[offset + 14] = clip[2]!
    data[offset + 15] = clip[3]!
    data[offset + 16] = options.blur * options.blur
    data[offset + 17] = options.dispersion
    data[offset + 18] = options.tintAlpha
    data[offset + 19] = options.specular
    // 染色先乘染色比例再混合，通透一端不会把另一端的染色冲淡。
    data[offset + 20] = tint[0] * brightness * options.tintAlpha
    data[offset + 21] = tint[1] * brightness * options.tintAlpha
    data[offset + 22] = tint[2] * brightness * options.tintAlpha
    data[offset + 23] = member.opacity
    // 倒角宽度在着色器里再按按压后的尺寸限制。
    data[offset + 24] = profileBevelWidth(halfDepth, options.bevelWidth)
    data[offset + 25] = profileBevelHeight(halfDepth, options.bevelHeight)
    data[offset + 26] = options.bevelCurve
    data[offset + 27] = options.bottomBevel
    offset += VOLUME_MEMBER_FLOATS
  }
}

/** 按玻璃层级合并邻近实体，并在每组中追踪三维折射光路。 */
export class VolumeGroups {
  private readonly gpu: StageGpu
  private readonly frame: FrameEncoder
  private readonly blur: BackdropBlur
  private readonly planner = new VolumePlanner()
  /**
   * 体积管线按成员数量缓存，分别对应画布与离屏目标的格式。按成员编号缓存会在滚动中不断遇到新组合，
   * 每次都要重新编译着色器，造成数十毫秒的单帧卡顿。
   */
  private readonly pipelines: PipelineTable[]
  /** `split` 之下与之上的两段。 */
  private readonly bands: VolumeBand[]
  /** 背景与各级模糊的绑定，按背景视图缓存；背景在页面快照与合成背景之间切换。 */
  private readonly textures = new WeakMap<GPUTextureView, VolumeTextures>()

  constructor(gpu: StageGpu, blur: BackdropBlur) {
    this.gpu = gpu
    this.frame = gpu.frame
    this.blur = blur
    this.pipelines = createVolumePipelines(gpu)
    this.bands = createVolumeBands(gpu)
  }

  /** 在后台编译常见成员数量的管线，第一次出现融合时不必等待着色器编译。 */
  warm(counts: readonly number[]): void {
    for (let i = 0; i < counts.length; i++) {
      this.pipelines[SLOT_CANVAS]!.warm(counts[i]!)
      this.pipelines[SLOT_TARGET]!.warm(counts[i]!)
    }
  }

  /**
   * 更新邻近关系，写入本帧的 uniform，把画布遍中的绘制项加入 `canvas`。
   *
   * 比例为 1 时体积直接画进画布。低于 1 时改画进低分辨率的离屏目标，再放大合成：
   * 玻璃后的背景本来就经过折射与模糊，降低分辨率主要让轮廓和高光略微变软，
   * 而页面文字和玻璃上的内容仍按画布分辨率绘制。
   *
   * 合成后一段内的所有体积先于这一段的内容绘制。被上层玻璃盖住的内容已由遮挡蒙版裁掉，
   * 差别只在于上层玻璃的阴影不再压暗下层玻璃上的文字。
   */
  plan(surfaces: readonly VolumeSurface[], count: number, source: GPUTextureView, shading: VolumeShading, canvas: DrawList): void {
    const bands = this.bands
    bands[0]!.list.reset()
    bands[1]!.list.reset()
    const planner = this.planner
    planner.build(surfaces, count, shading.cssWidth, shading.cssHeight)
    if (planner.count === 0)
      return
    const textures = this.textureGroup(source)
    if (shading.scale >= 1) {
      const pipelines = this.pipelines[SLOT_CANVAS]!
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        canvas.push(plan.order, pipelines.get(plan.count), this.write(plan, shading, shading.pixelWidth, shading.pixelHeight), textures)
      }
      return
    }

    const width = Math.max(1, Math.ceil(shading.pixelWidth * shading.scale))
    const height = Math.max(1, Math.ceil(shading.pixelHeight * shading.scale))
    const pipelines = this.pipelines[SLOT_TARGET]!
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
          band.list.push(plan.order, pipelines.get(plan.count), this.write(plan, shading, width, height), textures)
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

  /** 编码低分辨率的离屏绘制。目标清成全透明，体积按普通混合叠加后得到预乘颜色。 */
  encode(encoder: GPUCommandEncoder): void {
    for (let i = 0; i < this.bands.length; i++) {
      const band = this.bands[i]!
      if (band.list.count > 0)
        this.frame.encodePass(encoder, 'band', band.target.view, band.target.width, band.target.height, CLEAR_TRANSPARENT, band.list)
    }
  }

  /** 释放离屏目标。管线由 `StageGpu` 编译，随设备释放。 */
  dispose(): void {
    for (const band of this.bands)
      band.target.dispose()
  }

  private write(plan: VolumeGroupPlan, shading: VolumeShading, targetWidth: number, targetHeight: number): number {
    const bounds = plan.bounds
    const start = this.frame.rect(
      HEADER_FLOATS + VOLUME_GROUP_FLOATS + plan.count * VOLUME_MEMBER_FLOATS,
      bounds.left,
      bounds.top,
      bounds.right,
      bounds.bottom,
      shading.cssWidth,
      shading.cssHeight,
      targetWidth,
      targetHeight,
    )
    writeVolumeGroup(this.frame.data, start + HEADER_FLOATS, plan)
    return start * 4
  }

  private textureGroup(source: GPUTextureView): GPUBindGroup {
    const cached = this.textures.get(source)
    if (cached && cached.generation === this.blur.generation)
      return cached.group
    const bound = bindVolumeTextures(this.gpu, source, this.blur.views, this.blur.generation)
    this.textures.set(source, bound)
    return bound.group
  }
}
