import type { DrawList, FrameEncoder } from '../frame.hot'
import type { SampledTexture, StageGpu } from '../gpu'
import type { ContentPipelines } from './content-shader'
import type { FlowRect } from './flow.hot'
import type { VolumeSurface } from './fusion.hot'
import type { ElementBox, GlassSurface, Rect } from './surface'
import type { VolumeShading } from './VolumeGroups.hot'
import { attr, GLASS_CLIP_ATTR, GLASS_FADE_ATTR, GLASS_MODAL_ATTR } from '../contract'
import { glassContentRenderOrder } from '../render-order'
import { advanceSpring } from '../shared/spring.hot'
import { BackdropBlur } from './blur.hot'
import { covers, PaintOrder } from './content-order.hot'
import { createContentPipelines } from './content-shader'
import { writeContent } from './content.hot'
import { ContentBackdrop } from './ContentBackdrop.hot'
import { createElementBox, legacyShown, modalFactor } from './surface'
import { REFLECTION_VARIANCE } from './volume-shader'
import { VolumeGroups } from './VolumeGroups.hot'

/** 每帧代码需要的、由玻璃图层提供的冷路径操作。 */
export interface GlassFrameHost {
  /** 当前登记的全部玻璃，外层玻璃排在它的嵌套玻璃之前。 */
  readonly surfaces: readonly GlassSurface[]
  /** 本帧的页面快照。 */
  backdrop: () => SampledTexture | null
  /** 注销已经离开文档的玻璃。 */
  prune: () => void
  /** 元素或画布尺寸变化后重新确认快照尺寸，必要时重新创建纹理。 */
  refreshTextureSize: (surface: GlassSurface) => void
  /** 请求浏览器为这块玻璃生成新的绘制记录。 */
  kickPaint: (surface: GlassSurface) => void
  /** 上传玻璃的 HTML 内容，失败时返回 false 并安排重试。 */
  upload: (surface: GlassSurface) => boolean
  /** 请求下一帧。 */
  invalidate: () => void
  /** 开始逐帧推进弹簧与液体迁移。 */
  startAnimation: () => void
  /** 系统是否要求减少动态效果。 */
  reducedMotion: () => boolean
}

const MODAL_SELECTOR = attr(GLASS_MODAL_ATTR)
const CLIP_SELECTOR = attr(GLASS_CLIP_ATTR)
const FADE_SELECTOR = attr(GLASS_FADE_ATTR)
/** `checkVisibility()` 的参数：同时检查 `visibility`。 */
const VISIBILITY: CheckVisibilityOptions = { visibilityProperty: true }
/** 没有裁剪祖先时体积使用的裁剪范围。 */
const UNBOUNDED = 100000
/** 布局位置变化小于它时不更新元素的绘制位置。 */
const GEOMETRY_EPSILON = 0.05

function intersects(rect: Rect, width: number, height: number): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > 0
    && rect.top + rect.height > 0
    && rect.left < width
    && rect.top < height
}

function intersectsBox(rect: Rect, box: ElementBox): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > box.left
    && rect.top + rect.height > box.top
    && rect.left < box.right
    && rect.top < box.bottom
}

function copyRect(target: FlowRect, source: Rect): void {
  target.left = source.left
  target.top = source.top
  target.width = source.width
  target.height = source.height
}

/**
 * 玻璃图层每帧执行的部分：测量每块玻璃、决定何时上传内容、排列前后顺序，
 * 把内容、背景合成、模糊与体积写进本帧的 uniform 和绘制列表。
 *
 * 所有每帧使用的对象都在构造时或玻璃注册时创建，这里只改写字段。DOM 读取按祖先元素在一帧内共用：
 * 同一个定位基准、裁剪区域或淡入淡出容器只读取一次矩形或样式。
 */
export class GlassFrame {
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly frame: FrameEncoder
  private readonly host: GlassFrameHost
  private readonly blur: BackdropBlur
  private readonly volumes: VolumeGroups
  private readonly content: ContentPipelines
  private readonly backdrop: ContentBackdrop
  private readonly order = new PaintOrder()
  private readonly boxes = new WeakMap<Element, ElementBox>()
  /** 本帧可见的玻璃，排序后按从下到上排列，前 `visibleCount` 项有效。 */
  private readonly visible: GlassSurface[] = []
  private visibleCount = 0
  private readonly volumeList: VolumeSurface[] = []
  /** 本帧至少被一块上层玻璃覆盖的内容。 */
  private readonly occluded: GlassSurface[] = []
  private readonly shading: VolumeShading = {
    scale: 1,
    pixelWidth: 1,
    pixelHeight: 1,
    cssWidth: 1,
    cssHeight: 1,
    split: Infinity,
  }

  private readonly matrix: DOMMatrix
  private readonly geometry: ElementGeometryOptions
  private readonly body: FlowRect = { left: 0, top: 0, width: 0, height: 0 }
  private frameId = 0

  constructor(canvas: HTMLCanvasElement, root: HTMLElement, gpu: StageGpu, host: GlassFrameHost) {
    this.canvas = canvas
    this.root = root
    this.frame = gpu.frame
    this.host = host
    this.blur = new BackdropBlur(gpu)
    this.volumes = new VolumeGroups(gpu, this.blur)
    this.content = createContentPipelines(gpu)
    this.backdrop = new ContentBackdrop(gpu, this.content.occluded)
    // 浏览器在调用时复制变换，同一个矩阵可以每次改写后传入。
    this.matrix = new DOMMatrix()
    this.geometry = { canvasTransform: this.matrix }
  }

  /** 在后台编译常见数量的管线：体积按成员数量，内容按遮挡数量。 */
  warm(volumeCounts: readonly number[], occluderCounts: readonly number[]): void {
    this.volumes.warm(volumeCounts)
    for (let i = 0; i < occluderCounts.length; i++)
      this.content.clear.warm(occluderCounts[i]!)
  }

  /**
   * 设置玻璃体积的着色比例，下一次 `sync()` 生效。
   *
   * `split` 是画布遍中插在玻璃之间的其他内容的绘制顺序，降低分辨率时体积组在这里分成两段分别合成。
   */
  setShading(scale: number, split: number): void {
    this.shading.scale = scale
    this.shading.split = split
  }

  /**
   * 测量所有玻璃、上传变化的内容，并把本帧的绘制写入 uniform 与 `list`。
   *
   * `changed` 是浏览器本帧重新绘制过的元素。离屏的几遍（背景合成、模糊、低分辨率体积）
   * 由 `encode()` 编码。视口为空或页面快照不存在时返回 false。
   */
  sync(changed: readonly Element[], list: DrawList): boolean {
    const host = this.host
    const surfaces = host.surfaces
    const viewWidth = this.canvas.clientWidth
    const viewHeight = this.canvas.clientHeight
    if (viewWidth < 1 || viewHeight < 1)
      return false
    for (let i = 0; i < surfaces.length; i++) {
      if (!surfaces[i]!.element.isConnected) {
        host.prune()
        break
      }
    }
    this.frameId++
    this.order.begin()

    const modal = this.root.querySelector<HTMLElement>(MODAL_SELECTOR)
    const dimming = modal
      ? modalFactor(modal)
      : 1
    let maxBlur = 0
    let visibleCount = 0
    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i]!
      if (this.measureSurface(surface, changed, viewWidth, viewHeight, modal, dimming)) {
        this.visible[visibleCount++] = surface
        maxBlur = Math.max(maxBlur, surface.options.blur)
      }
    }
    this.visibleCount = visibleCount

    const page = host.backdrop()
    if (!page)
      return false
    this.arrange()
    const occludedCount = this.planContent(list, viewWidth, viewHeight)
    const composed = this.backdrop.plan(page, this.occluded, occludedCount, viewWidth, viewHeight)
    if (visibleCount > 0)
      this.blur.plan(composed.group, viewWidth, viewHeight, maxBlur * maxBlur + REFLECTION_VARIANCE)
    else
      this.blur.plan(composed.group, 0, 0, 0)
    const shading = this.shading
    shading.pixelWidth = this.canvas.width
    shading.pixelHeight = this.canvas.height
    shading.cssWidth = viewWidth
    shading.cssHeight = viewHeight
    this.volumes.plan(this.volumeList, visibleCount, composed.view, shading, list)
    return true
  }

  /** 编码 `sync()` 安排的离屏绘制，顺序为背景合成、模糊、低分辨率体积。 */
  encode(encoder: GPUCommandEncoder): void {
    this.backdrop.encode(encoder)
    this.blur.encode(encoder)
    this.volumes.encode(encoder)
  }

  /** 推进按压弹簧与液体迁移，返回是否仍有运动。`pressed` 是当前按住的玻璃。 */
  advanceMotion(seconds: number, pressed: HTMLElement | null, reduced: boolean): boolean {
    const surfaces = this.host.surfaces
    let moving = false
    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i]!
      const press = surface.element === pressed && !reduced
        ? 1
        : 0
      moving = advanceSpring(surface.press, press, seconds) || moving
      if (surface.flow)
        moving = surface.flow.advance(seconds) || moving
    }
    return moving
  }

  dispose(): void {
    this.backdrop.dispose()
    this.volumes.dispose()
    this.blur.dispose()
  }

  /** 测量一块玻璃并更新它的内容状态与体积，返回本帧是否可见。 */
  private measureSurface(
    surface: GlassSurface,
    changed: readonly Element[],
    viewWidth: number,
    viewHeight: number,
    modal: HTMLElement | null,
    dimming: number,
  ): boolean {
    const host = this.host
    const element = surface.element
    const nested = surface.host !== null
    let contentChanged = false
    if (!nested) {
      for (let k = 0; k < changed.length; k++) {
        if (element.contains(changed[k]!)) {
          contentChanged = true
          break
        }
      }
    }
    if (contentChanged) {
      surface.paintPending = false
      surface.dirty = true
      if (surface.retryTimer !== null) {
        window.clearTimeout(surface.retryTimer)
        surface.retryTimer = null
      }
    }

    this.measure(surface)
    const rect = surface.rect
    const anchor = surface.anchor !== null && surface.anchor.isConnected
      ? this.box(surface.anchor)
      : null
    const visible = this.shown(element)
      && intersects(rect, viewWidth, viewHeight)
      && (anchor === null || intersectsBox(rect, anchor))
    // 只有明确要求裁剪的媒体区域才限制玻璃，普通定位父元素允许阴影溢出。
    const clipElement = element.closest(CLIP_SELECTOR)
    const clip = clipElement
      ? this.box(clipElement)
      : null
    const fullyVisible = visible
      && rect.left >= Math.max(0, clip ? clip.left : 0)
      && rect.top >= Math.max(0, clip ? clip.top : 0)
      && rect.left + rect.width <= Math.min(viewWidth, clip ? clip.right : viewWidth) + 0.5
      && rect.top + rect.height <= Math.min(viewHeight, clip ? clip.bottom : viewHeight) + 0.5
    if (!nested) {
      if (visible && surface.sizeDirty)
        host.refreshTextureSize(surface)
      if (visible && (!surface.visible || (fullyVisible && !surface.fullyVisible))) {
        host.kickPaint(surface)
        surface.dirty = true
        surface.settleFrames = 4
      }
      if (visible && !surface.contentComplete && surface.placed
        && (rect.left !== surface.placedLeft || rect.top !== surface.placedTop)) {
        surface.dirty = true
        if (!contentChanged && !surface.paintPending)
          host.kickPaint(surface)
      }
      this.place(surface)
    }
    surface.visible = visible
    surface.fullyVisible = fullyVisible

    const opacity = this.fade(element)
    const brightness = modal !== null && modal.contains(element)
      ? 1
      : dimming
    this.flow(surface)
    surface.hasVolume = visible
    if (visible) {
      const volume = surface.volume
      volume.layer = surface.host
        ? surface.host.options.layer
        : surface.options.layer
      volume.options = surface.options
      volume.clip[0] = clip
        ? clip.left
        : -UNBOUNDED
      volume.clip[1] = clip
        ? clip.top
        : -UNBOUNDED
      volume.clip[2] = clip ? clip.right : UNBOUNDED
      volume.clip[3] = clip ? clip.bottom : UNBOUNDED
      volume.opacity = opacity
      volume.brightness = brightness
      volume.paintOrder = 0
      volume.press = surface.press.value
      surface.contentOpacity = opacity * brightness
      surface.padding = Math.max(surface.options.shadowSize, 0) + 2
      surface.contentClip[0] = clip ? clip.left : 0
      surface.contentClip[1] = clip ? clip.top : 0
      surface.contentClip[2] = clip ? clip.right : viewWidth
      surface.contentClip[3] = clip ? clip.bottom : viewHeight
    }

    // 有完整快照时保留离屏部分；首次只有部分可见时也要上传，否则文字会一直为空。
    const canUpload = !nested && visible && (fullyVisible || !surface.contentComplete || contentChanged)
    if (canUpload && !surface.paintPending && (surface.dirty || surface.settleFrames > 0)) {
      if (host.upload(surface)) {
        surface.contentComplete = fullyVisible
        surface.settleFrames = Math.max(0, surface.settleFrames - 1)
      }
      else {
        surface.settleFrames = 0
      }
    }
    if (canUpload && !surface.paintPending && surface.settleFrames > 0)
      host.invalidate()
    return visible
  }

  /** 按层级与 HTML 绘制顺序排列可见玻璃，并写入同层内的归一化顺序。 */
  private arrange(): void {
    const visible = this.visible
    const count = this.visibleCount
    for (let i = 1; i < count; i++) {
      const item = visible[i]!
      let j = i - 1
      while (j >= 0 && this.before(item, visible[j]!)) {
        visible[j + 1] = visible[j]!
        j--
      }
      visible[j + 1] = item
    }
    for (let i = 0; i < count; i++) {
      const volume = visible[i]!.volume
      volume.paintOrder = i / (count + 1)
      this.volumeList[i] = volume
    }
  }

  /** a 是否应排在 b 之前绘制。 */
  private before(a: GlassSurface, b: GlassSurface): boolean {
    const layers = a.volume.layer - b.volume.layer
    if (layers !== 0)
      return layers < 0
    return this.order.compare(a.element, b.element) < 0
  }

  /** 写入每块内容的清晰部分，收集被上层玻璃覆盖的内容，返回被覆盖内容的数量。 */
  private planContent(list: DrawList, viewWidth: number, viewHeight: number): number {
    const visible = this.visible
    const count = this.visibleCount
    const clear = this.content.clear
    const canvasWidth = this.canvas.width
    const canvasHeight = this.canvas.height
    let occludedCount = 0
    for (let i = 0; i < count; i++) {
      const surface = visible[i]!
      surface.occluderCount = 0
      const content = surface.content
      if (!content)
        continue
      for (let j = i + 1; j < count; j++) {
        const other = visible[j]!.volume
        // 嵌套玻璃画在外层内容之下，不遮挡外层的文字。
        if (other.host !== surface.id && covers(surface.rect, other))
          surface.occluders[surface.occluderCount++] = other
      }
      const uniform = writeContent(this.frame, surface, viewWidth, viewHeight, canvasWidth, canvasHeight)
      list.push(glassContentRenderOrder(surface.volume.layer, surface.volume.paintOrder), clear.get(surface.occluderCount), uniform, content.group)
      if (surface.occluderCount > 0)
        this.occluded[occludedCount++] = surface
    }
    return occludedCount
  }

  /**
   * 用 offset 系列属性相对定位基准测量元素，不受元素自身 transform 影响。
   * 定位基准依次是声明的锚点、`offsetParent`；都没有时直接使用 offset 值。
   */
  private measure(surface: GlassSurface): void {
    const element = surface.element
    const anchor = surface.anchor
    let base: HTMLElement | null = null
    if (anchor !== null && anchor.isConnected) {
      base = anchor
    }
    else {
      const parent = element.offsetParent
      if (parent instanceof HTMLElement)
        base = parent
    }
    if (base) {
      const box = this.box(base)
      surface.originX = box.left - base.scrollLeft
      surface.originY = box.top - base.scrollTop
    }
    else {
      surface.originX = 0
      surface.originY = 0
    }
    const layout = surface.layout
    layout.left = element.offsetLeft
    layout.top = element.offsetTop
    layout.width = element.offsetWidth
    layout.height = element.offsetHeight
    const rect = surface.rect
    rect.left = surface.originX + layout.left
    rect.top = surface.originY + layout.top
    rect.width = layout.width
    rect.height = layout.height
  }

  /** 元素在本帧的视口矩形，同一帧内只读取一次。 */
  private box(element: Element): ElementBox {
    const box = this.record(element)
    if (box.frame !== this.frameId) {
      box.frame = this.frameId
      const rect = element.getBoundingClientRect()
      box.left = rect.left
      box.top = rect.top
      box.right = rect.right
      box.bottom = rect.bottom
    }
    return box
  }

  /** 页面切换容器的透明度，同一帧内每个容器只读取一次。 */
  private fade(element: HTMLElement): number {
    const page = element.closest(FADE_SELECTOR)
    if (!(page instanceof HTMLElement))
      return 1
    const box = this.record(page)
    if (box.opacityFrame !== this.frameId) {
      box.opacityFrame = this.frameId
      const opacity = Number.parseFloat(getComputedStyle(page).opacity)
      box.opacity = Number.isFinite(opacity)
        ? opacity
        : 1
    }
    return box.opacity
  }

  private record(element: Element): ElementBox {
    return this.boxes.get(element) ?? this.track(element)
  }

  private track(element: Element): ElementBox {
    const box = createElementBox()
    this.boxes.set(element, box)
    return box
  }

  /** 元素是否显示。`checkVisibility()` 返回布尔值，不分配样式与矩形列表对象。 */
  private shown(element: HTMLElement): boolean {
    return typeof element.checkVisibility === 'function'
      ? element.checkVisibility(VISIBILITY)
      : legacyShown(element)
  }

  /** 位置变化时更新元素在画布中的绘制位置，命中测试随之移动。 */
  private place(surface: GlassSurface): void {
    const rect = surface.rect
    if (surface.placed
      && Math.abs(surface.placedLeft - rect.left) < GEOMETRY_EPSILON
      && Math.abs(surface.placedTop - rect.top) < GEOMETRY_EPSILON
      && Math.abs(surface.placedWidth - rect.width) < GEOMETRY_EPSILON
      && Math.abs(surface.placedHeight - rect.height) < GEOMETRY_EPSILON) {
      return
    }
    this.matrix.e = rect.left
    this.matrix.f = rect.top
    this.canvas.updateElementGeometry(surface.element, this.geometry)
    surface.placed = true
    surface.placedLeft = rect.left
    surface.placedTop = rect.top
    surface.placedWidth = rect.width
    surface.placedHeight = rect.height
  }

  /**
   * 体积在视口中的矩形，写入 `surface.volume`。
   *
   * 没有声明迁移的玻璃与元素重合。声明了迁移的玻璃在布局坐标系里跟随元素：
   * 布局矩形不受滚动影响，滚动时体积随页面移动，只有元素自己的位置或尺寸变化才触发流动。
   */
  private flow(surface: GlassSurface): void {
    const volume = surface.volume
    const flow = surface.flow
    if (flow === null) {
      copyRect(volume, surface.rect)
      return
    }
    if (surface.snapFlow || this.host.reducedMotion()) {
      flow.snap(surface.layout)
      surface.snapFlow = false
      copyRect(volume, surface.rect)
      return
    }
    if (flow.retarget(surface.layout))
      this.host.startAnimation()
    if (!flow.active) {
      copyRect(volume, surface.rect)
      return
    }
    const body = this.body
    flow.rect(body)
    volume.left = surface.originX + body.left
    volume.top = surface.originY + body.top
    volume.width = body.width
    volume.height = body.height
  }
}
