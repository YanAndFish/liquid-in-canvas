import type { DrawList } from '../frame.hot'
import type { ElementTexture, SampledTexture, StageGpu } from '../gpu'
import type { GlassTheme } from './defaults'
import type { GlassFrameHost } from './glass-frame.hot'
import type { GlassOptions } from './options'
import type { GlassSurface, Rect } from './surface'
import { attr, GLASS_ATTR } from '../contract'
import { createElementTexture, disposeElementTexture } from '../gpu'
import { reducedMotionQuery } from '../shared/motion'
import { onGlassDefaultsChange } from './defaults'
import { LiquidFlow } from './flow.hot'
import { GlassFrame } from './glass-frame.hot'
import { glassOptionsSignature, parseGlassOptions } from './options'
import { createSurface } from './surface'
import { GlassThemeSource } from './theme'

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

/** 元素相对定位基准的测量结果。 */
interface Placement {
  originX: number
  originY: number
  layout: Rect
  rect: Rect
}

interface PaintEventLike extends Event {
  changedElements?: readonly Element[]
}

/** 同名玻璃消失后，新玻璃在这段时间内出现才算接手，单位毫秒。 */
const HANDOVER_WINDOW = 400
/** 开始绘制时在后台编译的管线：成员数量与遮挡数量。更大的数量在第一次出现时同步编译。 */
const WARM_VOLUME_COUNTS = [1, 2, 3, 4]
const WARM_OCCLUDER_COUNTS = [0, 1, 2]
const GLASS_SELECTOR = attr(GLASS_ATTR)
const NO_ELEMENTS: readonly Element[] = []

/** 用 offset 系列属性相对定位基准测量元素，不受元素自身 transform 影响。 */
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

/**
 * 页面上全部 `[data-liquid-glass]` 的生命周期：注册与注销、DOM 变化、交互事件、内容纹理与液体迁移的交接。
 *
 * 每帧的测量与绘制在 `GlassFrame`（`glass-frame.hot.ts`）。这里实现它需要的冷路径操作，
 * 例如纹理尺寸变化时重新创建纹理、请求浏览器生成新的绘制记录。
 */
export class LiquidGlassLayer implements GlassFrameHost {
  /** 当前登记的全部玻璃，外层玻璃排在它的嵌套玻璃之前。 */
  readonly surfaces: GlassSurface[] = []
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly gpu: StageGpu
  private readonly getBackdrop: () => SampledTexture | null
  private readonly onInvalidate: () => void
  private readonly onFault: (cause: unknown) => void
  private readonly byElement = new Map<HTMLElement, GlassSurface>()
  private readonly paintToggle = new WeakSet<HTMLElement>()
  /** 最近消失的具名玻璃留下的体积位置，供同名玻璃接手。 */
  private readonly departed = new Map<string, { rect: Rect, time: number }>()
  private pressed: HTMLElement | null = null
  private animation = 0
  private previousTime = 0
  private nextId = 1
  private motion: MediaQueryList | null = null
  private observer: MutationObserver | null = null
  private readonly themeSource: GlassThemeSource
  private stopDefaults: (() => void) | null = null
  private frame: GlassFrame | null = null
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
    this.frame = new GlassFrame(this.canvas, this.root, this.gpu, this)
    this.frame.setShading(this.shadingScale, this.shadingSplit)
    this.frame.warm(WARM_VOLUME_COUNTS, WARM_OCCLUDER_COUNTS)
    this.observer = new MutationObserver(records => this.handleMutations(records))
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.themeSource.start()
    this.stopDefaults = onGlassDefaultsChange(() => this.refreshAll())
    window.addEventListener('resize', this.handleWindowResize, { passive: true })
    this.root.addEventListener('pointerdown', this.handlePointer, { passive: true })
    this.root.addEventListener('pointerleave', this.handlePointerLeave)
    window.addEventListener('pointerup', this.handlePointerUp)
    window.addEventListener('pointercancel', this.handlePointerUp)
    window.addEventListener('blur', this.handlePointerLeave)
    this.motion = reducedMotionQuery()
    this.scan()
  }

  /**
   * 测量所有玻璃、上传变化的内容，把本帧的绘制加入 `list`。
   * 离屏的几遍由 `encode()` 编码。尚未启动或页面快照不存在时返回 false。
   */
  sync(event: Event | undefined, list: DrawList): boolean {
    if (!this.started || this.disposed || !this.frame)
      return false
    return this.frame.sync((event as PaintEventLike | undefined)?.changedElements ?? NO_ELEMENTS, list)
  }

  /** 编码 `sync()` 安排的离屏绘制。 */
  encode(encoder: GPUCommandEncoder): void {
    this.frame?.encode(encoder)
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
    this.observer?.disconnect()
    this.observer = null
    this.themeSource.stop()
    this.stopDefaults?.()
    this.stopDefaults = null
    window.removeEventListener('resize', this.handleWindowResize)
    while (this.surfaces.length)
      this.unregister(this.surfaces[this.surfaces.length - 1]!)
    this.departed.clear()
    this.frame?.dispose()
    this.frame = null
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
    this.frame?.setShading(scale, split)
  }

  /** 画布的像素尺寸变化后，所有快照尺寸都要重新确认。 */
  invalidateSizes(): void {
    for (const surface of this.surfaces)
      surface.sizeDirty = true
  }

  backdrop(): SampledTexture | null {
    return this.getBackdrop()
  }

  invalidate(): void {
    this.onInvalidate()
  }

  reducedMotion(): boolean {
    return this.motion?.matches ?? false
  }

  prune(): void {
    for (const surface of [...this.surfaces]) {
      if (!surface.element.isConnected)
        this.unregister(surface)
    }
  }

  refreshTextureSize(surface: GlassSurface): void {
    surface.sizeDirty = false
    const size = this.textureSize(surface.element)
    if (size.width !== surface.textureWidth || size.height !== surface.textureHeight)
      this.resizeSurface(surface, size.width, size.height)
  }

  /** 强制浏览器更新嵌套 drawable 快照，供首次可见和尺寸变化后使用。 */
  kickPaint(surface: GlassSurface): void {
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

  upload(surface: GlassSurface): boolean {
    if (!surface.content)
      return false
    try {
      this.gpu.frame.upload(surface.element, surface.content.texture)
      surface.dirty = false
      return true
    }
    catch {
      surface.dirty = false
      this.scheduleRetry(surface)
      return false
    }
  }

  /** 交互结束、弹簧与液体迁移都静止后停止请求帧，静态页面无需持续重绘。 */
  startAnimation(): void {
    if (this.animation || this.disposed)
      return
    this.previousTime = performance.now()
    this.animation = requestAnimationFrame(this.animate)
  }

  private readonly animate = (now: number): void => {
    const seconds = (now - this.previousTime) / 1000
    const moving = this.frame?.advanceMotion(seconds, this.pressed, this.reducedMotion()) ?? false
    this.previousTime = now
    this.onInvalidate()
    this.animation = moving
      ? requestAnimationFrame(this.animate)
      : 0
  }

  /** 从实际命中的 HTML 控件取得交互目标，键盘焦点由浏览器绘制。 */
  private readonly handlePointer = (event: PointerEvent): void => {
    this.pressed = event.target instanceof Element
      ? event.target.closest<HTMLElement>(GLASS_SELECTOR)
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

  private scan(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>(GLASS_SELECTOR))
      this.register(element)
  }

  private register(element: HTMLElement): void {
    if (this.byElement.has(element) || !element.isConnected || !this.root.contains(element))
      return
    const outer = element.parentElement?.closest<HTMLElement>(GLASS_SELECTOR)
    if (outer)
      this.register(outer)
    const host = outer
      ? this.byElement.get(outer) ?? null
      : null
    // 只支持一层嵌套；外层还没能注册（例如尺寸为零）时稍后由变更记录再注册。
    if (outer && (!host || host.host))
      return

    const options = parseGlassOptions(element, this.theme())
    const anchor = this.resolveAnchor(element, options)
    const initial = this.place(element, anchor)
    if (!initial.rect.width || !initial.rect.height)
      return
    if (!this.getBackdrop() || !this.frame)
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

    const surface = createSurface({
      id: this.nextId++,
      element,
      host,
      anchor,
      options,
      signature: glassOptionsSignature(options),
      content,
      textureWidth: size.width,
      textureHeight: size.height,
      addedDrawable,
    })
    Object.assign(surface.layout, initial.layout)
    Object.assign(surface.rect, initial.rect)
    surface.originX = initial.originX
    surface.originY = initial.originY
    this.attachFlow(surface)

    if (!host) {
      this.canvas.updateElementGeometry(element, {
        canvasTransform: new DOMMatrix().translate(initial.rect.left, initial.rect.top),
      })
      surface.placed = true
      surface.placedLeft = initial.rect.left
      surface.placedTop = initial.rect.top
      surface.placedWidth = initial.rect.width
      surface.placedHeight = initial.rect.height
      surface.onScroll = () => {
        surface.dirty = true
        this.onInvalidate()
      }
      surface.onTransitionEnd = () => {
        surface.dirty = true
        this.onInvalidate()
      }
      surface.resizeObserver = new ResizeObserver(() => {
        surface.dirty = true
        surface.sizeDirty = true
        this.onInvalidate()
      })
      surface.resizeObserver.observe(element)
      element.addEventListener('scroll', surface.onScroll, { capture: true, passive: true })
      element.addEventListener('transitionend', surface.onTransitionEnd)
    }

    // 外层玻璃排在它的嵌套玻璃之前，外层注销时连同嵌套玻璃一起移除。
    this.surfaces.push(surface)
    this.byElement.set(element, surface)
    this.onInvalidate()
  }

  private unregister(surface: GlassSurface): void {
    if (this.byElement.get(surface.element) !== surface)
      return
    for (const other of [...this.surfaces]) {
      if (other.host === surface)
        this.unregister(other)
    }
    this.byElement.delete(surface.element)
    this.surfaces.splice(this.surfaces.indexOf(surface), 1)
    if (surface.options.morph && surface.hasVolume && !surface.handedOver) {
      const volume = surface.volume
      this.departed.set(surface.options.morph, {
        rect: {
          left: volume.left,
          top: volume.top,
          width: volume.width,
          height: volume.height,
        },
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
   * 声明了迁移的玻璃创建弹簧。
   *
   * 具名玻璃出现时，从同名玻璃的体积位置出发。页面在同一批 DOM 变更里把玻璃属性从一个元素移到
   * 另一个元素，两条变更记录的先后不固定：旧元素先注销时起点来自 `departed`，
   * 新元素先注册时直接取仍在登记中的同名表面。没有起点时弹簧停在元素当前的位置。
   */
  private attachFlow(surface: GlassSurface): void {
    const name = surface.options.morph
    if (name === null) {
      surface.flow = null
      return
    }
    const source = name && !this.reducedMotion()
      ? this.handover(name)
      : null
    if (!source) {
      surface.flow = new LiquidFlow(surface.layout)
      surface.snapFlow = true
      return
    }
    surface.flow = new LiquidFlow({
      left: source.left - surface.originX,
      top: source.top - surface.originY,
      width: source.width,
      height: source.height,
    })
    surface.snapFlow = false
    this.startAnimation()
  }

  /** 取得同名玻璃最近的体积位置并标记为已交接。 */
  private handover(name: string): Rect | null {
    const departed = this.departed.get(name)
    this.departed.delete(name)
    if (departed && performance.now() - departed.time < HANDOVER_WINDOW)
      return departed.rect
    for (const other of this.surfaces) {
      if (other.options.morph === name && other.hasVolume && !other.handedOver) {
        other.handedOver = true
        return other.volume
      }
    }
    return null
  }

  private readonly handleWindowResize = (): void => {
    this.scan()
    for (const surface of this.surfaces) {
      if (!surface.host)
        this.kickPaint(surface)
      surface.dirty = true
      surface.settleFrames = 4
      surface.sizeDirty = true
      // 窗口尺寸变化引起的重新排版不是迁移，体积直接到位。
      surface.snapFlow = true
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
            const surface = this.byElement.get(target)
            if (surface)
              this.unregister(surface)
          }
          invalidated = true
          continue
        }
        if (name.startsWith('data-glass-')) {
          const surface = this.byElement.get(target) ?? this.surfaceOwner(target)
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
          const glass = target.closest<HTMLElement>(GLASS_SELECTOR)
          if (glass && !this.byElement.has(glass))
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
    if (node.matches(GLASS_SELECTOR))
      this.register(node)
    for (const element of node.querySelectorAll<HTMLElement>(GLASS_SELECTOR))
      this.register(element)
  }

  /** 节点被移出页面时立即注销其中的玻璃，同名玻璃在同一批变更里出现时才能接手它的体积。 */
  private unregisterWithin(node: HTMLElement): void {
    if (node.isConnected)
      return
    for (const surface of [...this.surfaces]) {
      if (node.contains(surface.element))
        this.unregister(surface)
    }
  }

  /** 内容变化归属的玻璃。嵌套玻璃的 HTML 属于外层的内容快照。 */
  private surfaceOwner(element: HTMLElement | null): GlassSurface | null {
    let current = element
    while (current) {
      const surface = this.byElement.get(current)
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
    const morph = surface.options.morph
    surface.options = options
    surface.signature = signature
    surface.anchor = this.resolveAnchor(surface.element, options)
    if (options.morph !== morph) {
      surface.flow = options.morph === null
        ? null
        : new LiquidFlow(surface.layout)
      surface.snapFlow = true
    }
    surface.dirty = true
    this.onInvalidate()
  }

  private refreshAll(): void {
    for (const surface of this.surfaces)
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

  /** 注册时的测量。没有定位基准时退回元素自己的包围矩形。 */
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
        rect: { ...bounds },
      }
    }
    return offsetPlacement(element, base.getBoundingClientRect(), base.scrollLeft, base.scrollTop)
  }

  private textureSize(element: HTMLElement): { width: number, height: number } {
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

  private scheduleRetry(surface: GlassSurface): void {
    if (surface.retryTimer !== null)
      return
    surface.retryTimer = window.setTimeout(() => {
      surface.retryTimer = null
      if (this.byElement.get(surface.element) !== surface)
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
