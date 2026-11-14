import type { DrawList, FrameEncoder } from '../frame.hot'
import type { SampledTexture, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { ContentPipelines } from './content-shader'
import type { FlowRect } from './flow.hot'
import type { VolumeSurface } from './fusion.hot'
import type { ElementBox, GlassGhost, GlassSurface, Rect } from './surface'
import type { VolumeGroupPlan, VolumeShading } from './VolumeGroups.hot'
import { attr, GLASS_CLIP_ATTR, GLASS_FADE_ATTR, GLASS_MODAL_ATTR } from '../contract'
import { glassContentRenderOrder } from '../render-order'
import { advanceSpring } from '../shared/spring.hot'
import { BackdropBlur } from './blur.hot'
import { covers, PaintOrder } from './content-order.hot'
import { createContentPipelines } from './content-shader'
import { writeContent } from './content.hot'
import { ContentBackdrop } from './ContentBackdrop.hot'
import { rampedFusion } from './flow.hot'
import { growFloat64 } from './pools'
import { MAX_STACK_LEVELS, stackSees } from './stack.hot'
import { StackBackdrops } from './StackBackdrops.hot'
import { createElementBox, legacyShown, modalFactor } from './surface'
import { REFLECTION_VARIANCE } from './volume-shader'
import { VolumeGroups } from './VolumeGroups.hot'

/** 每帧代码需要的、由玻璃图层提供的冷路径操作。 */
export interface GlassFrameHost {
  /** 当前登记的全部玻璃，外层玻璃排在它的嵌套玻璃之前。 */
  readonly surfaces: readonly GlassSurface[]
  /** 正在流回同名玻璃的残影。每帧代码在残影结束时把它移出。 */
  readonly ghosts: GlassGhost[]
  /** 已经离开文档、正在退去的玻璃。 */
  readonly fading: GlassSurface[]
  /** 退去结束的玻璃：移出列表并释放内容纹理。 */
  release: (surface: GlassSurface) => void
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

/** 残影最后缩成的尺寸。 */
const GHOST_END = 2
/** 材质化弹簧的刚度与阻尼：阻尼比约 0.55、约 0.6 秒到位，出现时先越过再回落。 */
const MATERIALIZE_STIFFNESS = 120
const MATERIALIZE_DAMPING = 12
/** 材质化低于它时视为已经退去。 */
const MATERIALIZE_GONE = 0.01
/** 内容显现开始时的模糊半径，CSS 像素。 */
const REVEAL_BLUR = 6
/** 内容显现开始时的放大比例，收敛到原尺寸。展开时以来源为中心，出现时以内容中心为中心。 */
const REVEAL_ZOOM = 0.2
/** 展开期间玻璃额外加厚的比例：从来源长出来时更像一块厚透镜，到位后回到原厚度。 */
const REVEAL_SWELL = 0.3
/** 内容显现的时长，秒。 */
const REVEAL_SECONDS = 0.45
/** 目标面积比当前体积大这么多倍时算作展开，内容重新显现。 */
const GROW_RATIO = 1.2

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.left + a.width / 2 - b.left - b.width / 2, a.top + a.height / 2 - b.top - b.height / 2)
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
  /** 各级背景的模糊，下标是背景级别。 */
  private readonly blurs: BackdropBlur[] = []
  private readonly volumes: VolumeGroups
  private readonly content: ContentPipelines
  private readonly backdrop: ContentBackdrop
  private readonly stack: StackBackdrops
  /** 可见玻璃各自所在的组，与 `visible` 对齐。 */
  private readonly plans: (VolumeGroupPlan | null)[] = []
  /** 可见玻璃内容在画布遍中的绘制顺序，与 `visible` 对齐。 */
  private contentOrders = new Float64Array(32)
  private readonly order = new PaintOrder()
  private readonly boxes = new WeakMap<Element, ElementBox>()
  /** 本帧可见的玻璃，排序后按从下到上排列，前 `visibleCount` 项有效。 */
  private readonly visible: GlassSurface[] = []
  private visibleCount = 0
  private readonly volumeList: VolumeSurface[] = []
  /** `volumeList` 的有效长度：可见玻璃的体积加上正在流动的拖尾。 */
  private volumeCount = 0
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
  /** 残影本帧瞄准的目标矩形。 */
  private readonly ghostPoint: FlowRect = { left: 0, top: 0, width: 0, height: 0 }
  private frameId = 0

  constructor(canvas: HTMLCanvasElement, root: HTMLElement, gpu: StageGpu, host: GlassFrameHost) {
    this.canvas = canvas
    this.root = root
    this.frame = gpu.frame
    this.host = host
    for (let i = 0; i < MAX_STACK_LEVELS; i++)
      this.blurs.push(new BackdropBlur(gpu))
    this.volumes = new VolumeGroups(gpu, this.blurs)
    this.content = createContentPipelines(gpu)
    this.backdrop = new ContentBackdrop(gpu, this.content.occluded)
    this.stack = new StackBackdrops(gpu, this.blurs, this.content.stacked)
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

  /** 切换光路计算方式。 */
  setOptics(optics: GlassOptics): void {
    this.volumes.setOptics(optics)
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
      // 交接只在同一批 DOM 变更里有意义：到下一帧还在页面上的玻璃并没有交出体积。
      surface.handedOver = false
      if (this.measureSurface(surface, changed, viewWidth, viewHeight, modal, dimming)) {
        this.visible[visibleCount++] = surface
        maxBlur = Math.max(maxBlur, surface.options.blur)
      }
    }
    const fading = host.fading
    let f = 0
    while (f < fading.length) {
      const surface = fading[f]!
      if (surface.materialize.value <= MATERIALIZE_GONE && surface.materialize.velocity <= 0) {
        // release() 把它移出列表，同一下标换成下一项。
        host.release(surface)
        continue
      }
      this.applyMaterialize(surface)
      this.visible[visibleCount++] = surface
      maxBlur = Math.max(maxBlur, surface.options.blur)
      f++
    }
    this.visibleCount = visibleCount
    this.updateGhosts()

    const page = host.backdrop()
    if (!page)
      return false
    this.arrange()
    const volumes = this.volumes
    volumes.group(this.volumeList, this.volumeCount, viewWidth, viewHeight)
    const occludedCount = this.planContent(list, viewWidth, viewHeight)
    const composed = this.backdrop.plan(page, this.occluded, occludedCount, viewWidth, viewHeight)
    const blur = this.blurs[0]!
    if (visibleCount > 0)
      blur.plan(composed.group, viewWidth, viewHeight, maxBlur * maxBlur + REFLECTION_VARIANCE)
    else
      blur.plan(composed.group, 0, 0, 0)
    volumes.setSource(0, composed.view)
    this.stack.plan(volumes, composed, this.visible, this.plans, this.contentOrders, visibleCount, viewWidth, viewHeight)
    const shading = this.shading
    shading.pixelWidth = this.canvas.width
    shading.pixelHeight = this.canvas.height
    shading.cssWidth = viewWidth
    shading.cssHeight = viewHeight
    volumes.draw(shading, list)
    return true
  }

  /** 编码 `sync()` 安排的离屏绘制，顺序为背景合成、模糊、上层各级背景及其模糊、低分辨率体积。 */
  encode(encoder: GPUCommandEncoder): void {
    this.backdrop.encode(encoder)
    this.blurs[0]!.encode(encoder)
    this.stack.encode(encoder)
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
      moving = this.advanceMaterialize(surface, surface.shown ? 1 : 0, seconds, reduced) || moving
      if (surface.reveal < 1) {
        surface.reveal = reduced
          ? 1
          : Math.min(1, surface.reveal + Math.min(Math.max(seconds, 0), 1 / 30) / REVEAL_SECONDS)
        moving = true
      }
      if (surface.flow)
        moving = surface.flow.advance(seconds) || moving
    }
    const fading = this.host.fading
    for (let i = 0; i < fading.length; i++) {
      const surface = fading[i]!
      moving = advanceSpring(surface.press, 0, seconds) || moving
      moving = this.advanceMaterialize(surface, 0, seconds, reduced) || moving
    }
    const ghosts = this.host.ghosts
    for (let i = 0; i < ghosts.length; i++)
      moving = ghosts[i]!.flow.advance(seconds) || moving
    return moving
  }

  /** 推进材质化弹簧；关闭材质化或减少动态效果时直接到位。 */
  private advanceMaterialize(surface: GlassSurface, target: number, seconds: number, reduced: boolean): boolean {
    const spring = surface.materialize
    if (reduced || !surface.options.materialize) {
      spring.value = target
      spring.velocity = 0
      return false
    }
    return advanceSpring(spring, target, seconds, MATERIALIZE_STIFFNESS, MATERIALIZE_DAMPING)
  }

  /**
   * 内容从模糊、略微放大开始显现。`growing` 表示展开：内容按只扩大的可见范围显露，起点是当前体积。
   */
  private startReveal(surface: GlassSurface, growing: boolean): void {
    surface.reveal = 0
    surface.revealGrowing = growing
    const volume = surface.volume
    surface.revealX = volume.left + volume.width / 2
    surface.revealY = volume.top + volume.height / 2
    const reveal = surface.revealClip
    reveal[0] = volume.left
    reveal[1] = volume.top
    reveal[2] = volume.left + volume.width
    reveal[3] = volume.top + volume.height
  }

  /**
   * 把材质化与按压写进体积，把显现进度写进内容。
   *
   * 玻璃的厚度、透镜与尺寸随弹簧越过目标再回落；内容的不透明度、模糊与放大只看显现进度，
   * 按时间单调收敛，清晰之后不再变化，不随玻璃晃动。退去时内容随材质化淡出。
   */
  private applyMaterialize(surface: GlassSurface): void {
    const volume = surface.volume
    const amount = surface.materialize.value
    volume.materialize = amount
    volume.press = surface.press.value
    if (surface.hasTail)
      surface.tail.materialize = amount
    const base = volume.opacity * volume.brightness
    if (surface.hiding || surface.fading) {
      const settled = Math.min(1, Math.max(0, amount))
      const fade = Math.min(1, Math.max(0, (settled - 0.3) / 0.6))
      surface.contentOpacity = base * fade * fade * (3 - 2 * fade)
      surface.contentBlur = (1 - settled) * REVEAL_BLUR
      surface.contentScale = 1
      surface.contentOriginX = 0
      surface.contentOriginY = 0
      return
    }
    const progress = surface.reveal
    const eased = 1 - (1 - progress) * (1 - progress) * (1 - progress)
    const fade = Math.min(1, progress * 2)
    surface.contentOpacity = base * fade * fade * (3 - 2 * fade)
    surface.contentBlur = (1 - eased) * REVEAL_BLUR
    surface.contentScale = 1 + REVEAL_ZOOM * (1 - eased)
    const rect = surface.rect
    if (surface.revealGrowing && progress < 1) {
      // 缩放中心夹在元素之内：起点在元素外时，放大会把内容整个推开，看起来是从远处移过来。
      const originX = Math.min(Math.max(surface.revealX, rect.left), rect.left + rect.width)
      const originY = Math.min(Math.max(surface.revealY, rect.top), rect.top + rect.height)
      surface.contentOriginX = originX - rect.left - rect.width / 2
      surface.contentOriginY = originY - rect.top - rect.height / 2
      volume.materialize = amount * (1 + REVEAL_SWELL * (1 - eased))
      if (surface.hasTail)
        surface.tail.materialize = volume.materialize
    }
    else {
      surface.contentOriginX = 0
      surface.contentOriginY = 0
    }
  }

  dispose(): void {
    this.backdrop.dispose()
    this.stack.dispose()
    this.volumes.dispose()
    for (let i = 0; i < this.blurs.length; i++)
      this.blurs[i]!.dispose()
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

    const shown = this.shown(element)
    if (shown !== surface.shown) {
      surface.shown = shown
      const animate = surface.options.materialize && !host.reducedMotion()
      if (shown) {
        // 出现或由隐藏变为显示：重新材质化。滚动进入视口不会经过这里。
        // 从同名玻璃流出来的体积已经是完整的玻璃，只让内容显现。
        const handover = surface.flow !== null && surface.flow.active
        surface.hiding = false
        // 隐藏期间元素可能移动过：直接在新位置出现，不从隐藏前的位置流过去。
        if (!handover && surface.everShown)
          surface.snapFlow = true
        surface.everShown = true
        surface.materialize.value = animate && !handover
          ? 0
          : 1
        surface.materialize.velocity = 0
        if (animate) {
          this.startReveal(surface, handover)
          host.startAnimation()
        }
      }
      else if (animate && surface.visible && surface.materialize.value > MATERIALIZE_GONE) {
        surface.hiding = true
        host.startAnimation()
      }
    }
    if (surface.hiding) {
      // 元素已经隐藏，布局读数无效：沿用上一帧的位置与内容退去。
      if (surface.materialize.value > MATERIALIZE_GONE || surface.materialize.velocity > 0) {
        this.applyMaterialize(surface)
        return true
      }
      surface.hiding = false
    }

    this.measure(surface)
    const rect = surface.rect
    const anchor = surface.anchor !== null && surface.anchor.isConnected
      ? this.box(surface.anchor)
      : null
    const visible = shown
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
    // 隐藏的元素读到的是空矩形，不能让液体迁移流向它；重新显示时从原处出现。
    if (shown)
      this.flow(surface)
    else
      surface.hasTail = false
    surface.hasVolume = visible
    if (visible) {
      const volume = surface.volume
      volume.layer = surface.host
        ? surface.host.options.layer
        : surface.options.layer
      volume.options = surface.options
      volume.fusion = this.fusionOf(surface)
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
      if (surface.hasTail) {
        const tail = surface.tail
        tail.layer = volume.layer
        tail.options = volume.options
        tail.clip[0] = volume.clip[0]!
        tail.clip[1] = volume.clip[1]!
        tail.clip[2] = volume.clip[2]!
        tail.clip[3] = volume.clip[3]!
        tail.opacity = opacity
        tail.brightness = brightness
      }
      surface.contentOpacity = opacity * brightness
      surface.padding = Math.max(surface.options.shadowSize, 0) + 2
      surface.contentClip[0] = clip ? clip.left : 0
      surface.contentClip[1] = clip ? clip.top : 0
      surface.contentClip[2] = clip ? clip.right : viewWidth
      surface.contentClip[3] = clip ? clip.bottom : viewHeight
      // 元素已经是新尺寸，体积还在过渡：内容只画在体积之内，随玻璃展开显露、收拢遮住。
      // 展开时可见范围只扩大不缩小，玻璃越过目标后回弹、晃动时内容的边缘保持不动。
      if (surface.flow !== null && surface.flow.resizing) {
        const reveal = surface.revealClip
        let left = volume.left
        let top = volume.top
        let right = volume.left + volume.width
        let bottom = volume.top + volume.height
        // 从更大的同名玻璃收拢回来（例如购物袋关闭后回到按钮）不是展开：内容随体积显露。
        if (surface.revealGrowing && rect.width * rect.height < (reveal[2]! - reveal[0]!) * (reveal[3]! - reveal[1]!))
          surface.revealGrowing = false
        if (surface.revealGrowing) {
          reveal[0] = Math.min(reveal[0]!, left)
          reveal[1] = Math.min(reveal[1]!, top)
          reveal[2] = Math.max(reveal[2]!, right)
          reveal[3] = Math.max(reveal[3]!, bottom)
          left = reveal[0]!
          top = reveal[1]!
          right = reveal[2]!
          bottom = reveal[3]!
        }
        surface.contentClip[0] = Math.max(surface.contentClip[0]!, left)
        surface.contentClip[1] = Math.max(surface.contentClip[1]!, top)
        surface.contentClip[2] = Math.min(surface.contentClip[2]!, right)
        surface.contentClip[3] = Math.min(surface.contentClip[3]!, bottom)
      }
      this.applyMaterialize(surface)
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

  /**
   * 这块玻璃本帧的融合距离。从仍在页面上的同名玻璃里流出来时，两者之间按中心距离渐进；
   * 流动结束后恢复为声明的融合距离。
   */
  private fusionOf(surface: GlassSurface): number {
    const limit = surface.options.fusion
    const partner = surface.partner
    if (partner === null)
      return limit
    if (surface.flow === null || !surface.flow.active || !partner.hasVolume) {
      surface.partner = null
      return limit
    }
    return rampedFusion(limit, centerDistance(surface.volume, partner.volume))
  }

  /**
   * 推进残影：每帧瞄准目标玻璃的中心并缩小到一点，层级、裁剪和透明度跟随目标，
   * 融合距离随离目标中心的距离渐进。到达、静止或目标不可见时移除。
   */
  private updateGhosts(): void {
    const ghosts = this.host.ghosts
    let i = 0
    while (i < ghosts.length) {
      const ghost = ghosts[i]!
      const target = ghost.target
      const volume = ghost.volume
      const goal = target.volume
      let alive = target.hasVolume && target.element.isConnected && !this.host.reducedMotion()
      if (alive) {
        const point = this.ghostPoint
        point.left = goal.left + goal.width / 2 - GHOST_END / 2
        point.top = goal.top + goal.height / 2 - GHOST_END / 2
        point.width = GHOST_END
        point.height = GHOST_END
        const options = target.options
        ghost.flow.configure(options.morphStretch, options.morphBounce, options.morphWobble)
        if (ghost.flow.retarget(point))
          this.host.startAnimation()
        ghost.flow.rect(volume)
        alive = ghost.flow.active && volume.width * volume.height > GHOST_END * GHOST_END * 2
      }
      if (!alive) {
        // 与最后一项交换后移出，不分配新数组。
        ghosts[i] = ghosts[ghosts.length - 1]!
        ghosts.pop()
        continue
      }
      volume.layer = goal.layer
      volume.host = goal.host
      volume.clip[0] = goal.clip[0]!
      volume.clip[1] = goal.clip[1]!
      volume.clip[2] = goal.clip[2]!
      volume.clip[3] = goal.clip[3]!
      volume.opacity = goal.opacity
      volume.brightness = goal.brightness
      volume.fusion = rampedFusion(Math.min(volume.options.fusion, target.options.fusion), centerDistance(volume, goal))
      i++
    }
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
    // 拖尾排在所有本体之后；分组时它按距离并入本体所在的组。
    let total = count
    for (let i = 0; i < count; i++) {
      const surface = visible[i]!
      if (!surface.hasTail)
        continue
      surface.tail.paintOrder = surface.volume.paintOrder
      this.volumeList[total++] = surface.tail
    }
    const ghosts = this.host.ghosts
    for (let i = 0; i < ghosts.length; i++) {
      const ghost = ghosts[i]!
      ghost.volume.paintOrder = ghost.target.volume.paintOrder
      this.volumeList[total++] = ghost.volume
    }
    this.volumeCount = total
  }

  /** a 是否应排在 b 之前绘制。正在退去的玻璃已经离开文档，排在同层其他玻璃之上。 */
  private before(a: GlassSurface, b: GlassSurface): boolean {
    const layers = a.volume.layer - b.volume.layer
    if (layers !== 0)
      return layers < 0
    if (a.fading || b.fading)
      return !a.fading && b.fading
    return this.order.compare(a.element, b.element) < 0
  }

  /**
   * 写入每块内容的清晰部分，收集被上层玻璃覆盖、需要写进页面背景的内容，返回这些内容的数量。
   *
   * 能在更高一级背景里直接看到这块玻璃的上层玻璃仍然裁掉画布里被覆盖的部分，
   * 但不再把这部分写进页面背景：它的背景已经画了这块玻璃的完整内容。
   */
  private planContent(list: DrawList, viewWidth: number, viewHeight: number): number {
    const visible = this.visible
    const count = this.visibleCount
    const clear = this.content.clear
    const groups = this.volumes.groups
    const canvasWidth = this.canvas.width
    const canvasHeight = this.canvas.height
    if (this.contentOrders.length < count)
      this.contentOrders = growFloat64(count)
    let occludedCount = 0
    for (let i = 0; i < count; i++) {
      const surface = visible[i]!
      const plan = groups.planOf(surface.volume)
      this.plans[i] = plan
      surface.occluderCount = 0
      surface.backdropOccluderCount = 0
      const order = glassContentRenderOrder(surface.volume.layer, surface.volume.paintOrder)
      this.contentOrders[i] = order
      const content = surface.content
      if (!content)
        continue
      for (let j = i + 1; j < count; j++) {
        const other = visible[j]!.volume
        // 嵌套玻璃画在外层内容之下，不遮挡外层的文字。
        if (other.host === surface.id || !covers(surface.rect, other))
          continue
        surface.occluders[surface.occluderCount++] = other
        const above = groups.planOf(other)
        if (plan === null || above === null || above.level <= plan.level || !stackSees(plan, above))
          surface.backdropOccluders[surface.backdropOccluderCount++] = other
      }
      const uniform = writeContent(this.frame, surface, surface.occluders, surface.occluderCount, viewWidth, viewHeight, canvasWidth, canvasHeight)
      list.push(order, clear.get(surface.occluderCount), uniform, content.group)
      if (surface.backdropOccluderCount > 0)
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
    surface.hasTail = false
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
    const options = surface.options
    flow.configure(options.morphStretch, options.morphBounce, options.morphWobble)
    // 只有从静止开始的展开才让内容重新显现；同一次过渡里的后续目标（例如布局尺寸动画）不会让清晰的内容再模糊。
    const resting = !flow.active
    if (flow.retarget(surface.layout)) {
      const layout = surface.layout
      if (resting && surface.reveal >= 1 && options.materialize && layout.width * layout.height > volume.width * volume.height * GROW_RATIO)
        this.startReveal(surface, true)
      this.host.startAnimation()
    }
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
    // 没有融合距离时拖尾无法与本体相连，会成为单独的一团，因此不画。
    if (options.fusion > 0 && flow.tail(body)) {
      const tail = surface.tail
      tail.left = surface.originX + body.left
      tail.top = surface.originY + body.top
      tail.width = body.width
      tail.height = body.height
      tail.fusion = flow.tailFusion(options.fusion)
      surface.hasTail = true
    }
  }
}
