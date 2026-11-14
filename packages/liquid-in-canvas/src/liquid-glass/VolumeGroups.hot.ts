import type { DrawList, FrameEncoder } from '../frame.hot'
import type { PipelineTable, RenderTarget, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { BackdropBlur } from './blur.hot'
import type { CoverBuilder, CoverRect } from './cover.hot'
import type { GlassGroup, NumberSink, VolumeSurface } from './fusion.hot'
import type { ProfileTable } from './optics-lut'
import type { StackGroup, StackLevel } from './stack.hot'
import type { VolumeTextures } from './volume-shader'
import { CLEAR_TRANSPARENT, HEADER_FLOATS } from '../frame'
import { SLOT_CANVAS, SLOT_TARGET } from '../gpu'
import { glassVolumeRenderOrder } from '../render-order'
import { linearTint, srgbToLinear } from './color'
import { GlassGroups, writePressedBox } from './fusion.hot'
import { createProfileTable, createStackLevels, createVolumeBands, createVolumePlan, growInt32 } from './pools'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from './profile'
import { assignStackLevels, MAX_STACK_LEVELS, stackMargin } from './stack.hot'
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
 * 传入 `profiles` 时同时写入每名成员的剖面查找表行号（剖面光学）。
 */
export function writeVolumeGroup(data: NumberSink, start: number, plan: VolumeGroupPlan, profiles: ProfileTable | null = null): void {
  // 背景已经含有遮罩。仅压暗新增的染色与高光，玻璃覆盖率保持不变。
  const brightness = srgbToLinear(plan.members[0]!.brightness)
  data[start] = plan.ceiling
  data[start + 1] = plan.reach
  data[start + 2] = brightness
  data[start + 4] = plan.shadowAlpha
  data[start + 5] = plan.shadowSize
  const valid = plan.valid
  data[start + 8] = valid.left
  data[start + 9] = valid.top
  data[start + 10] = valid.right
  data[start + 11] = valid.bottom
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
      data[offset + 28] = profiles.rowOf(bevelWidth / halfDepth, data[offset + 25]! / halfDepth, options.bevelCurve, options.bottomBevel, options.dispersion)
    }
    offset += VOLUME_MEMBER_FLOATS
  }
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
  /** 剖面光学的管线，第一次切换到剖面光学时创建。 */
  private profilePipelines: PipelineTable[] | null = null
  /** 剖面光学的查找表。 */
  private profiles: ProfileTable | null = null
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
    this.pipelines = createVolumePipelines(gpu)
    this.bands = createVolumeBands(gpu)
  }

  /** 本帧的分组与背景分级，`group()` 之后有效。 */
  get groups(): VolumePlanner {
    return this.planner
  }

  /** 在后台编译常见成员数量的管线，第一次出现融合时不必等待着色器编译。 */
  warm(counts: readonly number[]): void {
    const pipelines = this.table()
    for (let i = 0; i < counts.length; i++) {
      pipelines[SLOT_CANVAS]!.warm(counts[i]!)
      pipelines[SLOT_TARGET]!.warm(counts[i]!)
    }
  }

  /** 切换光路计算方式。第一次切到剖面光学时创建查找表并在后台编译常见数量的管线。 */
  setOptics(optics: GlassOptics): void {
    if (optics === this.optics)
      return
    this.optics = optics
    if (optics === 'profile' && !this.profilePipelines) {
      const created = createProfileTable(this.gpu)
      this.profilePipelines = created.pipelines
      this.profiles = created.table
    }
  }

  /** 按层级与邻近关系分组，并为每组分配背景级别。 */
  group(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number): void {
    this.planner.build(surfaces, count, cssWidth, cssHeight)
  }

  /** 设置第 `level` 级背景本帧的纹理视图。 */
  setSource(level: number, view: GPUTextureView): void {
    this.sources[level] = view
  }

  /** 分组、设置第 0 级背景并安排绘制，等同于依次调用 `group()`、`setSource()` 与 `draw()`。 */
  plan(surfaces: readonly VolumeSurface[], count: number, source: GPUTextureView, shading: VolumeShading, canvas: DrawList): void {
    this.group(surfaces, count, shading.cssWidth, shading.cssHeight)
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
      const pipelines = this.table()[SLOT_CANVAS]!
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        canvas.push(plan.order, pipelines.get(plan.count), this.write(plan, shading.cssWidth, shading.cssHeight, shading.pixelWidth, shading.pixelHeight), this.textureGroup(plan.level))
      }
      return
    }

    const width = Math.max(1, Math.ceil(shading.pixelWidth * shading.scale))
    const height = Math.max(1, Math.ceil(shading.pixelHeight * shading.scale))
    const pipelines = this.table()[SLOT_TARGET]!
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
          band.list.push(plan.order, pipelines.get(plan.count), this.write(plan, shading.cssWidth, shading.cssHeight, width, height), this.textureGroup(plan.level))
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
    const uniform = this.writeRect(plan, left, top, right, bottom, cssWidth, cssHeight, targetWidth, targetHeight)
    list.push(plan.order, this.table()[SLOT_TARGET]!.get(plan.count), uniform, this.textureGroup(plan.level))
  }

  /** 编码低分辨率的离屏绘制。目标清成全透明，体积按普通混合叠加后得到预乘颜色。 */
  encode(encoder: GPUCommandEncoder): void {
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
  }

  /** 当前光路计算方式的管线表。 */
  private table(): PipelineTable[] {
    return this.optics === 'profile' && this.profilePipelines
      ? this.profilePipelines
      : this.pipelines
  }

  /** 当前光路计算方式使用的查找表；三维求交时为 null。 */
  private profileTable(): ProfileTable | null {
    return this.optics === 'profile'
      ? this.profiles
      : null
  }

  private write(plan: VolumeGroupPlan, cssWidth: number, cssHeight: number, targetWidth: number, targetHeight: number): number {
    const bounds = plan.bounds
    return this.writeRect(plan, bounds.left, bounds.top, bounds.right, bounds.bottom, cssWidth, cssHeight, targetWidth, targetHeight)
  }

  /** 写入一组体积的 uniform，只绘制给定矩形（CSS 像素）。 */
  private writeRect(
    plan: VolumeGroupPlan,
    left: number,
    top: number,
    right: number,
    bottom: number,
    cssWidth: number,
    cssHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): number {
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
    writeVolumeGroup(this.frame.data, start + HEADER_FLOATS, plan, this.profileTable())
    return start * 4
  }

  private textureGroup(level: number): GPUBindGroup {
    const source = this.sources[level] ?? this.sources[0]!
    const blur = this.blurs[level] ?? this.blurs[0]!
    const profiles = this.profileTable()
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
