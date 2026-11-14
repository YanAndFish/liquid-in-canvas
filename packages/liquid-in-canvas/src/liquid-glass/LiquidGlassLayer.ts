import type { DrawItem, ElementTexture, SampledTexture, StageGpu } from '../gpu'
import type { GlassTheme } from './defaults'
import type { VolumeSurface } from './fusion'
import type { GlassOptions } from './options'
import { attr, GLASS_ATTR, GLASS_CLIP_ATTR, GLASS_FADE_ATTR, GLASS_MODAL_ATTR, GLASS_SCRIM_ATTR } from '../contract'
import { createElementTexture, disposeElementTexture, uploadElement } from '../gpu'
import { glassContentRenderOrder } from '../render-order'
import { reducedMotionQuery } from '../shared/motion'
import { advanceSpring } from '../shared/spring'
import { BackdropBlur } from './blur'
import { planGlassContent, warmContentPipeline } from './content-material'
import { contentOccluders, createHtmlPaintOrderComparator } from './content-order'
import { ContentBackdrop } from './ContentBackdrop'
import { onGlassDefaultsChange } from './defaults'
import { LiquidFlow } from './flow'
import { glassOptionsSignature, parseGlassOptions } from './options'
import { GlassThemeSource } from './theme'
import { REFLECTION_VARIANCE } from './volume-shader'
import { VolumeGroups } from './VolumeGroups'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 元素的布局矩形，以及把它换算到视口的原点。 */
interface Placement {
  /** 布局坐标系的原点在视口中的位置：定位基准的左上角减去它的滚动量。 */
  originX: number
  originY: number
  /** 元素相对定位基准的布局矩形，不受滚动影响。 */
  layout: Rect
  /** 元素在视口中的矩形。 */
  rect: Rect
}

interface GlassSurface {
  /** 生命周期内稳定的表面编号。 */
  id: number
  element: HTMLElement
  /**
   * 嵌套玻璃所在的外层玻璃，顶层玻璃为 null。
   *
   * 嵌套玻璃只有体积：它的 HTML 已经包含在外层的内容快照里。体积画在外层体积之上、
   * 外层内容之下，不遮挡外层的文字。
   */
  host: GlassSurface | null
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string
  /** 体积正在流向元素的当前位置；没有声明迁移或尚未测量时为 null。 */
  flow: LiquidFlow | null
  /** 上一帧体积在视口中的矩形，供同名玻璃接手时作为起点。 */
  volumeRect: Rect | null
  /** 体积已经交给另一块同名玻璃，注销时不再留下起点。 */
  handedOver: boolean
  /** 玻璃上 HTML 内容的快照。 */
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  lastGeometry: Rect | null
  dirty: boolean
  settleFrames: number
  /** 等待浏览器为这块玻璃生成新的绘制记录。 */
  paintPending: boolean
  /** 当前纹理是否曾在整块玻璃可见时上传。 */
  contentComplete: boolean
  /** 上一帧是否与视口相交。 */
  visible: boolean
  /** 上一帧是否完整位于视口与媒体裁剪区域内。 */
  fullyVisible: boolean
  addedDrawable: boolean
  resizeObserver: ResizeObserver | null
  retryTimer: number | null
  onScroll: () => void
  onTransitionEnd: () => void
}

export interface LiquidGlassLayerOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement
  gpu: StageGpu
  /** 本帧的页面快照，同时是玻璃折射与模糊的背景。 */
  getBackdrop: () => SampledTexture | null
  /** 固定主题；缺省时读取 `<html data-theme>`，再退回系统配色。 */
  theme?: GlassTheme | null
  onInvalidate: () => void
  onFault: (cause: unknown) => void
}

/** 一帧玻璃的绘制结果。 */
export interface GlassFrame {
  /** 画布遍中的绘制项：体积（或低分辨率合成的分块）与玻璃上的清晰内容。 */
  items: DrawItem[]
  /** 本帧可见的玻璃，按从下到上的顺序排列。 */
  surfaces: VolumeSurface[]
}

/** 同名玻璃消失后，新玻璃在这段时间内出现才算接手，单位毫秒。 */
const HANDOVER_WINDOW = 400
/** 开始绘制时在后台编译的管线：成员数量与遮挡数量。更大的数量在第一次出现时同步编译。 */
const WARM_VOLUME_COUNTS = [1, 2, 3, 4]
const WARM_OCCLUDER_COUNTS = [0, 1, 2]

interface PaintEventLike extends Event {
  changedElements?: readonly Element[]
}

function intersects(rect: Rect, width: number, height: number): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > 0
    && rect.top + rect.height > 0
    && rect.left < width
    && rect.top < height
}

/** 按定位基准的位置与滚动量，把元素的布局矩形换算到视口。 */
function offsetPlacement(element: HTMLElement, base: { left: number, top: number }, scrollLeft: number, scrollTop: number): Placement {
  const originX = base.left - scrollLeft
  const originY = base.top - scrollTop
  const layout = {
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }
  return {
    originX,
    originY,
    layout,
    rect: {
      ...layout,
      left: originX + layout.left,
      top: originY + layout.top,
    },
  }
}

function intersectsRect(rect: Rect, other: DOMRect): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > other.left
    && rect.top + rect.height > other.top
    && rect.left < other.right
    && rect.top < other.bottom
}

function colorAlpha(value: string): number {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (!match?.[1])
    return 1
  const parts = match[1].split(',').map(part => Number.parseFloat(part))
  const alpha = parts.length === 4
    ? parts[3]
    : 1
  return alpha === undefined || !Number.isFinite(alpha)
    ? 1
    : Math.min(1, Math.max(0, alpha))
}

export class LiquidGlassLayer {
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly gpu: StageGpu
  private readonly getBackdrop: () => SampledTexture | null
  private readonly onInvalidate: () => void
  private readonly onFault: (cause: unknown) => void
  private readonly surfaces = new Map<HTMLElement, GlassSurface>()
  private readonly viewport = { width: 1, height: 1 }
  private readonly paintToggle = new WeakSet<HTMLElement>()
  /** 最近消失的具名玻璃留下的体积位置，供同名玻璃接手。 */
  private readonly departed = new Map<string, { rect: Rect, time: number }>()
  private pressed: HTMLElement | null = null
  private feedback = new Map<HTMLElement, { press: { value: number, velocity: number } }>()
  private animation = 0
  private previousTime = 0
  private nextId = 1
  private reducedMotion: MediaQueryList | null = null
  private observer: MutationObserver | null = null
  private readonly themeSource: GlassThemeSource
  private stopDefaults: (() => void) | null = null
  private blur: BackdropBlur | null = null
  private volumes: VolumeGroups | null = null
  private contentBackdrop: ContentBackdrop | null = null
  private shadingScale = 1
  private shadingSplit = Infinity
  private started = false
  private disposed = false

  constructor(options: LiquidGlassLayerOptions) {
    this.canvas = options.canvas
    this.root = options.root
    this.gpu = options.gpu
    this.getBackdrop = options.getBackdrop
    this.themeSource = new GlassThemeSource(() => this.refreshAll(), options.theme ?? null)
    this.onInvalidate = options.onInvalidate
    this.onFault = options.onFault
  }

  start(): void {
    if (this.started || this.disposed)
      return
    if (typeof this.canvas.updateElementGeometry !== 'function' || typeof this.canvas.getElementImageDefaultSize !== 'function')
      return

    this.started = true
    this.viewport.width = this.canvas.clientWidth
    this.viewport.height = this.canvas.clientHeight
    this.observer = new MutationObserver(records => this.handleMutations(records))
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.themeSource.start()
    this.stopDefaults = onGlassDefaultsChange(() => this.refreshAll())
    this.blur = new BackdropBlur(this.gpu)
    this.volumes = new VolumeGroups(this.gpu, this.blur)
    this.contentBackdrop = new ContentBackdrop(this.gpu)
    this.volumes.warm(WARM_VOLUME_COUNTS)
    for (const count of WARM_OCCLUDER_COUNTS)
      warmContentPipeline(this.gpu, count, 'clear', this.gpu.canvasFormat)
    window.addEventListener('resize', this.handleWindowResize, { passive: true })
    this.root.addEventListener('pointerdown', this.handlePointer, { passive: true })
    this.root.addEventListener('pointerleave', this.handlePointerLeave)
    window.addEventListener('pointerup', this.handlePointerUp)
    window.addEventListener('pointercancel', this.handlePointerUp)
    window.addEventListener('blur', this.handlePointerLeave)
    this.reducedMotion = reducedMotionQuery()
    this.scan()
  }

  /**
   * 测量所有玻璃、上传变化的内容，并把本帧的绘制写入 uniform。
   *
   * 返回画布遍中的绘制项；离屏的几遍（背景合成、模糊、低分辨率体积）由 `encode()` 编码。
   * 尚未启动或页面快照不存在时返回 null。
   */
  sync(event?: Event): GlassFrame | null {
    if (!this.started || this.disposed)
      return null
    this.viewport.width = this.canvas.clientWidth
    this.viewport.height = this.canvas.clientHeight
    const viewWidth = this.viewport.width
    const viewHeight = this.viewport.height
    if (viewWidth < 1 || viewHeight < 1)
      return null

    const changed = (event as PaintEventLike | undefined)?.changedElements ?? []
    const modal = this.root.querySelector<HTMLElement>(attr(GLASS_MODAL_ATTR))
    const dimming = this.modalFactor(modal)
    let maxBlur = 0
    const volumeSurfaces: VolumeSurface[] = []
    const surfaceById = new Map<number, { surface: GlassSurface, rect: Rect, clip: DOMRect | undefined, opacity: number }>()
    for (const surface of [
      ...this.surfaces.values(),
    ]) {
      if (!surface.element.isConnected) {
        this.unregister(surface)
        continue
      }

      const nested = surface.host !== null
      const contentChanged = !nested && changed.some(element => surface.element.contains(element))
      if (contentChanged) {
        surface.paintPending = false
        surface.dirty = true
        if (surface.retryTimer !== null) {
          window.clearTimeout(surface.retryTimer)
          surface.retryTimer = null
        }
      }

      const placement = this.measure(surface)
      const rect = placement.rect

      const anchorRect = surface.anchor?.isConnected
        ? surface.anchor.getBoundingClientRect()
        : null
      const style = getComputedStyle(surface.element)
      const visible = style.visibility !== 'hidden' && style.display !== 'none'
        && surface.element.getClientRects().length > 0
        && intersects(rect, viewWidth, viewHeight)
        && (!anchorRect || intersectsRect(rect, anchorRect))
      const clip = surface.element.closest<HTMLElement>(attr(GLASS_CLIP_ATTR))?.getBoundingClientRect()
      const fullyVisible = visible && rect.left >= Math.max(0, clip?.left ?? 0)
        && rect.top >= Math.max(0, clip?.top ?? 0)
        && rect.left + rect.width <= Math.min(viewWidth, clip?.right ?? viewWidth) + 0.5
        && rect.top + rect.height <= Math.min(viewHeight, clip?.bottom ?? viewHeight) + 0.5
      if (visible)
        maxBlur = Math.max(maxBlur, surface.options.blur)
      if (!nested) {
        const size = this.textureSize(surface)
        if (visible && (size.width !== surface.textureWidth || size.height !== surface.textureHeight))
          this.resizeSurface(surface, size.width, size.height)
        if (visible && (!surface.visible || (fullyVisible && !surface.fullyVisible))) {
          this.kickPaint(surface)
          surface.dirty = true
          surface.settleFrames = 4
        }
        if (visible && !surface.contentComplete && surface.lastGeometry
          && (rect.left !== surface.lastGeometry.left || rect.top !== surface.lastGeometry.top)) {
          surface.dirty = true
          if (!contentChanged && !surface.paintPending)
            this.kickPaint(surface)
        }
        this.updateGeometry(surface, rect)
      }
      surface.visible = visible
      surface.fullyVisible = fullyVisible
      const feedback = this.feedback.get(surface.element)
      const opacity = this.pageOpacity(surface.element)
      const brightness = modal?.contains(surface.element)
        ? 1
        : dimming
      const body = this.flowRect(surface, placement)
      surface.volumeRect = visible
        ? body
        : null
      if (visible) {
        surfaceById.set(surface.id, {
          surface,
          rect,
          clip,
          opacity: opacity * brightness,
        })
        volumeSurfaces.push({
          id: surface.id,
          ...body,
          // 嵌套玻璃与外层同层绘制。
          options: surface.host && surface.host.options.layer !== surface.options.layer
            ? { ...surface.options, layer: surface.host.options.layer }
            : surface.options,
          ...(surface.host
            ? { host: surface.host.id }
            : {}),
          clip: [
            clip?.left ?? -100000,
            clip?.top ?? -100000,
            clip?.right ?? 100000,
            clip?.bottom ?? 100000,
          ],
          opacity,
          brightness,
          paintOrder: 0,
          press: feedback?.press.value ?? 0,
        })
      }

      // 有完整快照时保留离屏部分；首次只有部分可见时也要上传，否则文字会一直为空。
      const canUpload = !nested && visible && (fullyVisible || !surface.contentComplete || contentChanged)
      if (canUpload && !surface.paintPending && (surface.dirty || surface.settleFrames > 0)) {
        if (this.upload(surface)) {
          surface.contentComplete = fullyVisible
          surface.settleFrames = Math.max(0, surface.settleFrames - 1)
        }
        else {
          surface.settleFrames = 0
        }
      }
      if (canUpload && !surface.paintPending && surface.settleFrames > 0)
        this.onInvalidate()
    }

    const backdrop = this.getBackdrop()
    const blur = this.blur
    const volumes = this.volumes
    const contentBackdrop = this.contentBackdrop
    if (!backdrop || !blur || !volumes || !contentBackdrop)
      return null

    const comparePaintOrder = createHtmlPaintOrderComparator()
    volumeSurfaces.sort((a, b) => a.options.layer - b.options.layer
      || comparePaintOrder(surfaceById.get(a.id)!.surface.element, surfaceById.get(b.id)!.surface.element))
    const canvasTarget = {
      targetWidth: this.canvas.width,
      targetHeight: this.canvas.height,
      cssWidth: viewWidth,
      cssHeight: viewHeight,
    }
    const backdropSize = ContentBackdrop.targetSize(viewWidth, viewHeight)
    const backdropTarget = {
      targetWidth: backdropSize.width,
      targetHeight: backdropSize.height,
      cssWidth: viewWidth,
      cssHeight: viewHeight,
    }
    const items: DrawItem[] = []
    const overlays: ReturnType<typeof planGlassContent>[] = []
    volumeSurfaces.forEach((volume, index) => {
      volume.paintOrder = index / (volumeSurfaces.length + 1)
      const { surface, rect, clip, opacity } = surfaceById.get(volume.id)!
      if (!surface.content)
        return
      const content = {
        ...rect,
        padding: Math.max(surface.options.shadowSize, 0) + 2,
        // 只有明确要求裁剪的媒体区域才限制玻璃，普通定位父元素允许阴影溢出。
        clip: [
          clip?.left ?? 0,
          clip?.top ?? 0,
          clip?.right ?? viewWidth,
          clip?.bottom ?? viewHeight,
        ] as const,
        opacity,
        // 嵌套玻璃画在外层内容之下，不遮挡外层的文字。
        occluders: contentOccluders(rect, volumeSurfaces.slice(index + 1).filter(other => other.host !== volume.id)),
        textures: surface.content.group,
      }
      const draw = planGlassContent(this.gpu, content, canvasTarget)
      items.push(draw('clear', this.gpu.canvasFormat, glassContentRenderOrder(volume.options.layer, volume.paintOrder)))
      if (content.occluders.length)
        overlays.push(planGlassContent(this.gpu, content, backdropTarget))
    })
    const composed = contentBackdrop.plan(backdrop, overlays, viewWidth, viewHeight)
    if (volumeSurfaces.length > 0)
      blur.plan(composed.group, viewWidth, viewHeight, maxBlur * maxBlur + REFLECTION_VARIANCE)
    else
      blur.plan(composed.group, 0, 0)
    items.push(...volumes.plan(volumeSurfaces, composed.view, {
      scale: this.shadingScale,
      pixelWidth: this.canvas.width,
      pixelHeight: this.canvas.height,
      cssWidth: viewWidth,
      cssHeight: viewHeight,
      split: this.shadingSplit,
    }))
    return { items, surfaces: volumeSurfaces }
  }

  /** 编码 `sync()` 安排的离屏绘制，顺序为背景合成、模糊、低分辨率体积。 */
  encode(encoder: GPUCommandEncoder): void {
    this.contentBackdrop?.encode(encoder)
    this.blur?.encode(encoder)
    this.volumes?.encode(encoder)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    cancelAnimationFrame(this.animation)
    this.root.removeEventListener('pointerdown', this.handlePointer)
    this.root.removeEventListener('pointerleave', this.handlePointerLeave)
    window.removeEventListener('pointerup', this.handlePointerUp)
    window.removeEventListener('pointercancel', this.handlePointerUp)
    window.removeEventListener('blur', this.handlePointerLeave)
    this.feedback.clear()
    this.observer?.disconnect()
    this.observer = null
    this.themeSource.stop()
    this.stopDefaults?.()
    this.stopDefaults = null
    window.removeEventListener('resize', this.handleWindowResize)
    for (const surface of [
      ...this.surfaces.values(),
    ])
      this.unregister(surface)
    this.surfaces.clear()
    this.departed.clear()
    this.contentBackdrop?.dispose()
    this.contentBackdrop = null
    this.volumes?.dispose()
    this.volumes = null
    this.blur?.dispose()
    this.blur = null
  }

  /** 固定主题，传入 null 恢复跟随页面。 */
  setTheme(theme: GlassTheme | null): void {
    this.themeSource.set(theme)
  }

  /**
   * 设置玻璃体积的着色比例，下一次 `sync()` 生效。
   *
   * `split` 是画布遍中插在玻璃之间的其他内容的绘制顺序，降低分辨率时体积组在这里分成两段分别合成。
   */
  setShading(scale: number, split: number): void {
    this.shadingScale = scale
    this.shadingSplit = split
  }

  /** 从实际命中的 HTML 控件取得交互目标，键盘焦点由浏览器绘制。 */
  private readonly handlePointer = (event: PointerEvent): void => {
    this.pressed = event.target instanceof Element
      ? event.target.closest<HTMLElement>(attr(GLASS_ATTR))
      : null
    this.startAnimation()
    this.onInvalidate()
  }

  private readonly handlePointerUp = (): void => {
    this.pressed = null
    this.startAnimation()
  }

  private readonly handlePointerLeave = (): void => {
    this.pressed = null
    this.startAnimation()
  }

  /** 交互结束、弹簧与液体迁移都静止后停止请求帧，静态页面无需持续重绘。 */
  private startAnimation(): void {
    if (this.animation || this.disposed)
      return
    this.previousTime = performance.now()
    this.animation = requestAnimationFrame(this.animate)
  }

  private readonly animate = (now: number): void => {
    const seconds = (now - this.previousTime) / 1000
    let moving = false
    for (const [element, feedback] of this.feedback) {
      const press = element === this.pressed && !this.reducedMotion?.matches
        ? 1
        : 0
      moving = advanceSpring(feedback.press, press, seconds) || moving
    }
    for (const surface of this.surfaces.values())
      moving = (surface.flow?.advance(seconds) ?? false) || moving
    this.previousTime = now
    this.onInvalidate()
    this.animation = moving
      ? requestAnimationFrame(this.animate)
      : 0
  }

  private scan(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
      this.register(element)
  }

  private register(element: HTMLElement): void {
    if (this.surfaces.has(element) || !element.isConnected || !this.root.contains(element))
      return
    const outer = element.parentElement?.closest<HTMLElement>(attr(GLASS_ATTR))
    if (outer)
      this.register(outer)
    const host = outer
      ? this.surfaces.get(outer) ?? null
      : null
    // 只支持一层嵌套；外层还没能注册（例如尺寸为零）时稍后由变更记录再注册。
    if (outer && (!host || host.host))
      return

    const options = parseGlassOptions(element, this.theme())
    const anchor = this.resolveAnchor(element, options)
    const initial = this.place(element, anchor)
    if (!initial.rect.width || !initial.rect.height)
      return

    if (!this.getBackdrop() || !this.blur)
      return

    const size = host
      ? { width: 0, height: 0 }
      : this.textureSize(element)
    const content = host
      ? null
      : this.createContentTexture(size.width, size.height)
    if (!host && !content)
      return

    const addedDrawable = !host && !element.hasAttribute('drawable')
    if (addedDrawable)
      element.setAttribute('drawable', '')

    if (!host) {
      this.canvas.updateElementGeometry(element, {
        canvasTransform: new DOMMatrix().translate(initial.rect.left, initial.rect.top),
      })
    }

    const surface: GlassSurface = {
      id: this.nextId++,
      element,
      host,
      anchor,
      options,
      signature: glassOptionsSignature(options),
      flow: this.inheritFlow(options, initial),
      volumeRect: null,
      handedOver: false,
      content,
      textureWidth: size.width,
      textureHeight: size.height,
      lastGeometry: null,
      dirty: true,
      settleFrames: 4,
      paintPending: false,
      contentComplete: false,
      visible: false,
      fullyVisible: false,
      addedDrawable,
      resizeObserver: null,
      retryTimer: null,
      onScroll: () => {
        surface.dirty = true
        this.onInvalidate()
      },
      onTransitionEnd: () => {
        surface.dirty = true
        this.onInvalidate()
      },
    }

    this.feedback.set(element, {
      press: { value: 0, velocity: 0 },
    })
    this.surfaces.set(element, surface)
    if (!host) {
      surface.resizeObserver = new ResizeObserver(() => {
        surface.dirty = true
        this.onInvalidate()
      })
      surface.resizeObserver.observe(element)
      element.addEventListener('scroll', surface.onScroll, { capture: true, passive: true })
      element.addEventListener('transitionend', surface.onTransitionEnd)
      this.updateGeometry(surface, initial.rect)
    }
    this.onInvalidate()
  }

  private unregister(surface: GlassSurface): void {
    if (!this.surfaces.has(surface.element))
      return
    for (const other of [
      ...this.surfaces.values(),
    ]) {
      if (other.host === surface)
        this.unregister(other)
    }
    this.surfaces.delete(surface.element)
    this.feedback.delete(surface.element)
    if (surface.options.morph && surface.volumeRect && !surface.handedOver) {
      this.departed.set(surface.options.morph, {
        rect: surface.volumeRect,
        time: performance.now(),
      })
    }
    surface.resizeObserver?.disconnect()
    if (surface.retryTimer !== null) {
      window.clearTimeout(surface.retryTimer)
      surface.retryTimer = null
    }
    surface.element.removeEventListener('scroll', surface.onScroll, { capture: true })
    surface.element.removeEventListener('transitionend', surface.onTransitionEnd)
    if (!surface.host && typeof this.canvas.clearElementGeometry === 'function')
      this.canvas.clearElementGeometry(surface.element)
    if (surface.addedDrawable)
      surface.element.removeAttribute('drawable')
    // kickPaint 写入的透明阴影只用于触发重绘，退出时还原，避免遮住样式表中的阴影。
    if (this.paintToggle.delete(surface.element) || surface.element.style.boxShadow.includes('rgba(0, 0, 0, 0)'))
      surface.element.style.boxShadow = ''
    disposeElementTexture(surface.content)
    surface.content = null
    this.onInvalidate()
  }

  /**
   * 具名玻璃出现时，从同名玻璃的体积位置出发。
   *
   * 页面在同一批 DOM 变更里把玻璃属性从一个元素移到另一个元素，两条变更记录的先后不固定：
   * 旧元素先注销时起点来自 `departed`，新元素先注册时直接取仍在登记中的同名表面。
   */
  private inheritFlow(options: GlassOptions, placement: Placement): LiquidFlow | null {
    const name = options.morph
    if (!name || this.reducedMotion?.matches)
      return null
    let source: Rect | null = null
    const departed = this.departed.get(name)
    this.departed.delete(name)
    if (departed && performance.now() - departed.time < HANDOVER_WINDOW) {
      source = departed.rect
    }
    else {
      for (const other of this.surfaces.values()) {
        if (other.options.morph === name && other.volumeRect && !other.handedOver) {
          source = other.volumeRect
          other.handedOver = true
          break
        }
      }
    }
    if (!source)
      return null
    this.startAnimation()
    return new LiquidFlow({
      left: source.left - placement.originX,
      top: source.top - placement.originY,
      width: source.width,
      height: source.height,
    })
  }

  /**
   * 体积在视口中的矩形。
   *
   * 没有声明迁移的玻璃与元素重合。声明了迁移的玻璃在布局坐标系里跟随元素：
   * 布局矩形不受滚动影响，滚动时体积随页面移动，只有元素自己的位置或尺寸变化才触发流动。
   */
  private flowRect(surface: GlassSurface, placement: Placement): Rect {
    if (surface.options.morph === null) {
      surface.flow = null
      return placement.rect
    }
    if (!surface.flow) {
      surface.flow = new LiquidFlow(placement.layout)
      return placement.rect
    }
    if (this.reducedMotion?.matches) {
      surface.flow.snap(placement.layout)
      return placement.rect
    }
    if (surface.flow.retarget(placement.layout))
      this.startAnimation()
    if (!surface.flow.active)
      return placement.rect
    const body = surface.flow.rect()
    return {
      left: placement.originX + body.left,
      top: placement.originY + body.top,
      width: body.width,
      height: body.height,
    }
  }

  private readonly handleWindowResize = (): void => {
    this.scan()
    for (const surface of this.surfaces.values()) {
      if (!surface.host)
        this.kickPaint(surface)
      surface.dirty = true
      surface.settleFrames = 4
      // 窗口尺寸变化引起的重新排版不是迁移，体积直接到位。
      surface.flow = null
    }
    this.onInvalidate()
  }

  private handleMutations(records: MutationRecord[]): void {
    let invalidated = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as HTMLElement
        const name = record.attributeName ?? ''
        if (name === GLASS_ATTR) {
          if (target.hasAttribute(GLASS_ATTR)) {
            this.register(target)
          }
          else {
            const surface = this.surfaces.get(target)
            if (surface)
              this.unregister(surface)
          }
          invalidated = true
          continue
        }
        if (name.startsWith('data-glass-')) {
          const surface = this.surfaces.get(target) ?? this.surfaceOwner(target)
          if (surface)
            this.refresh(surface)
          invalidated = true
          continue
        }
        const surface = this.surfaceOwner(target)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
        else {
          const glass = target.closest<HTMLElement>(attr(GLASS_ATTR))
          if (glass && !this.surfaces.has(glass))
            this.register(glass)
        }
        continue
      }

      if (record.type === 'childList') {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement)
            this.unregisterWithin(node)
        }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement)
            this.registerWithin(node)
        }
        const surface = this.surfaceOwner(record.target as HTMLElement)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
        else if (record.addedNodes.length || record.removedNodes.length) {
          invalidated = true
        }
        continue
      }

      if (record.type === 'characterData') {
        const surface = this.surfaceOwner(record.target.parentElement)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
      }
    }
    if (invalidated)
      this.onInvalidate()
  }

  private registerWithin(node: HTMLElement): void {
    if (node.matches(attr(GLASS_ATTR)))
      this.register(node)
    for (const element of node.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
      this.register(element)
  }

  /** 节点被移出页面时立即注销其中的玻璃，同名玻璃在同一批变更里出现时才能接手它的体积。 */
  private unregisterWithin(node: HTMLElement): void {
    if (node.isConnected)
      return
    for (const surface of [
      ...this.surfaces.values(),
    ]) {
      if (node.contains(surface.element))
        this.unregister(surface)
    }
  }

  private surfaceOwner(element: HTMLElement | null): GlassSurface | null {
    let current = element
    while (current) {
      const surface = this.surfaces.get(current)
      // 嵌套玻璃的 HTML 属于外层的内容快照。
      if (surface)
        return surface.host ?? surface
      current = current.parentElement
    }
    return null
  }

  private refresh(surface: GlassSurface): void {
    const options = parseGlassOptions(surface.element, this.theme())
    const signature = glassOptionsSignature(options)
    if (signature === surface.signature)
      return
    surface.options = options
    surface.signature = signature
    surface.anchor = this.resolveAnchor(surface.element, options)
    surface.dirty = true
    this.onInvalidate()
  }

  private refreshAll(): void {
    for (const surface of this.surfaces.values())
      this.refresh(surface)
  }

  private resolveAnchor(element: HTMLElement, options: GlassOptions): HTMLElement | null {
    if (options.anchor) {
      try {
        const anchor = document.querySelector<HTMLElement>(options.anchor)
        if (anchor && !element.contains(anchor))
          return anchor
      }
      catch {}
    }
    const parent = element.offsetParent
    return parent instanceof HTMLElement
      ? parent
      : null
  }

  /**
   * 用 offset 系列属性相对定位基准测量元素，不受元素自身 transform 影响。
   * 没有定位基准时退回元素自己的包围矩形。
   */
  private place(element: HTMLElement, base: HTMLElement | null): Placement {
    if (!base) {
      const rect = element.getBoundingClientRect()
      const bounds = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
      return {
        originX: 0,
        originY: 0,
        layout: bounds,
        rect: bounds,
      }
    }
    return offsetPlacement(element, base.getBoundingClientRect(), base.scrollLeft, base.scrollTop)
  }

  private measure(surface: GlassSurface): Placement {
    const element = surface.element
    const anchor = surface.anchor
    if (anchor?.isConnected)
      return this.place(element, anchor)
    const parent = element.offsetParent
    if (parent instanceof HTMLElement)
      return this.place(element, parent)
    return offsetPlacement(element, { left: 0, top: 0 }, 0, 0)
  }

  private updateGeometry(surface: GlassSurface, rect: Rect): void {
    const last = surface.lastGeometry
    if (last
      && Math.abs(last.left - rect.left) < 0.05
      && Math.abs(last.top - rect.top) < 0.05
      && Math.abs(last.width - rect.width) < 0.05
      && Math.abs(last.height - rect.height) < 0.05) {
      return
    }
    this.canvas.updateElementGeometry(surface.element, {
      canvasTransform: new DOMMatrix().translate(rect.left, rect.top),
    })
    surface.lastGeometry = rect
  }

  /** 强制浏览器更新嵌套 drawable 快照，供首次可见和尺寸变化后使用。 */
  private kickPaint(surface: GlassSurface): void {
    const element = surface.element
    surface.paintPending = true
    const alternate = !this.paintToggle.has(element)
    if (alternate)
      this.paintToggle.add(element)
    else
      this.paintToggle.delete(element)
    // 两个完全透明的阴影交替，重复进入视口也会触发新的绘制记录。
    element.style.boxShadow = `${alternate ? 0.001 : 0}px 0 0 1px rgba(0, 0, 0, 0)`
    this.scheduleRetry(surface)
    this.onInvalidate()
  }

  /** 模态层外玻璃的亮度比例；没有模态层时为 1。 */
  private modalFactor(modal: HTMLElement | null): number {
    const scrim = modal?.querySelector<HTMLElement>(attr(GLASS_SCRIM_ATTR))
    if (!modal || !scrim)
      return 1
    const shellOpacity = Number.parseFloat(getComputedStyle(modal).opacity)
    const opacity = Number.isFinite(shellOpacity)
      ? shellOpacity
      : 1
    return 1 - colorAlpha(getComputedStyle(scrim).backgroundColor) * opacity
  }

  private pageOpacity(element: HTMLElement): number {
    const page = element.closest(attr(GLASS_FADE_ATTR))
    if (!(page instanceof HTMLElement))
      return 1
    const opacity = Number.parseFloat(getComputedStyle(page).opacity)
    return Number.isFinite(opacity)
      ? opacity
      : 1
  }

  private textureSize(surfaceOrElement: GlassSurface | HTMLElement): { width: number, height: number } {
    const element = surfaceOrElement instanceof HTMLElement
      ? surfaceOrElement
      : surfaceOrElement.element
    try {
      const size = this.canvas.getElementImageDefaultSize(element)
      if (size.width >= 1 && size.height >= 1) {
        return {
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
        }
      }
    }
    catch {}
    const dpr = typeof window === 'undefined'
      ? 1
      : window.devicePixelRatio || 1
    return {
      width: Math.max(1, Math.ceil(element.offsetWidth * dpr)),
      height: Math.max(1, Math.ceil(element.offsetHeight * dpr)),
    }
  }

  private createContentTexture(width: number, height: number): ElementTexture | null {
    try {
      return createElementTexture(this.gpu, width, height)
    }
    catch (cause) {
      this.onFault(cause)
      return null
    }
  }

  private resizeSurface(surface: GlassSurface, width: number, height: number): void {
    const content = this.createContentTexture(width, height)
    if (!content)
      return
    disposeElementTexture(surface.content)
    surface.content = content
    surface.textureWidth = width
    surface.textureHeight = height
    surface.dirty = true
    surface.contentComplete = false
    surface.settleFrames = 4
    this.kickPaint(surface)
  }

  private upload(surface: GlassSurface): boolean {
    if (!surface.content)
      return false
    try {
      uploadElement(this.gpu.device, surface.element, surface.content.texture)
      surface.dirty = false
      return true
    }
    catch {
      surface.dirty = false
      this.scheduleRetry(surface)
      return false
    }
  }

  private scheduleRetry(surface: GlassSurface): void {
    if (surface.retryTimer !== null)
      return
    surface.retryTimer = window.setTimeout(() => {
      surface.retryTimer = null
      if (!this.surfaces.has(surface.element))
        return
      surface.dirty = true
      if (surface.visible)
        this.kickPaint(surface)
    }, 180)
  }

  private theme(): GlassTheme {
    return this.themeSource.value
  }
}
