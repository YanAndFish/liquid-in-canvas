import type { ElementTexture } from './gpu'
import type { GlassTheme } from './liquid-glass/defaults'
import type { GlassOptics, StageMetrics, StageResolution } from './types'
import { AdaptiveScale } from './adaptive.hot'
import { CanvasOverlay } from './CanvasOverlay.hot'
import { attr, STAGE_OVERLAY_ATTR } from './contract'
import { FrameProbe } from './frame-probe.hot'
import { createElementTexture, createStageDevice, disposeElementTexture, StageGpu } from './gpu'
import { LiquidGlassLayer } from './liquid-glass/LiquidGlassLayer'
import { DEFAULT_STAGE_RESOLUTION, resolveGlassPixelRatio, resolvePixelRatio } from './resolution'
import { StageFrame } from './stage-frame.hot'
import { VideoClock } from './video-clock'

export interface CanvasStageOptions {
  /** 带有 `content="drawable"` 的画布，页面根元素需要是它的后代。 */
  canvas: HTMLCanvasElement
  /** 初始化之后发生不可恢复的错误时调用，舞台随后停止绘制。 */
  onFault: (cause: unknown) => void
  /** 渲染分辨率限制，缺省值见 `DEFAULT_STAGE_RESOLUTION`。 */
  resolution?: Partial<StageResolution>
  /** 固定玻璃主题；缺省时读取 `<html data-theme>`，再退回系统配色。 */
  theme?: GlassTheme
  /** 光路计算方式，缺省为 `profile`，见 `GlassOptics`。 */
  optics?: GlassOptics
}

function sameSize(a: StageMetrics, b: StageMetrics): boolean {
  return a.cssWidth === b.cssWidth
    && a.cssHeight === b.cssHeight
    && a.pixelWidth === b.pixelWidth
    && a.pixelHeight === b.pixelHeight
}

export class CanvasStage {
  private readonly canvas: HTMLCanvasElement
  private readonly onFault: (cause: unknown) => void
  private gpu: StageGpu | null = null
  /** 每帧的绘制，见 `stage-frame.hot.ts`。 */
  private frame: StageFrame | null = null
  /** 整页快照，同时作为玻璃折射与模糊的背景。 */
  private page: ElementTexture | null = null
  private observer: ResizeObserver | null = null
  private root: HTMLElement | null = null
  private overlay: CanvasOverlay | null = null
  private glass: LiquidGlassLayer | null = null
  private metrics: StageMetrics | null = null
  private pendingSize: StageMetrics | null = null
  private resolution: StageResolution
  private readonly adaptive = new AdaptiveScale()
  /** 区分“按页面自己的节拍绘制”与“跟不上显示器”，供自适应降级取样。 */
  private readonly frameProbe = new FrameProbe()
  /** 有新的视频帧时请求重绘。 */
  private readonly videoClock = new VideoClock(() => this.invalidate())
  private theme: GlassTheme | null
  private optics: GlassOptics
  private cssSize = { width: 0, height: 0 }
  private initialized = false
  private failed = false
  private disposed = false

  constructor(options: CanvasStageOptions) {
    this.canvas = options.canvas
    this.onFault = options.onFault
    this.resolution = {
      ...DEFAULT_STAGE_RESOLUTION,
      ...options.resolution,
    }
    this.theme = options.theme ?? null
    this.optics = options.optics ?? 'profile'
    this.adaptive.setRelaxable(this.optics !== 'profile')
  }

  async init(): Promise<StageMetrics> {
    if (this.initialized)
      return this.snapshot()

    if (this.canvas.content !== 'drawable')
      this.canvas.setAttribute('content', 'drawable')

    const { device, context, format } = await createStageDevice(this.canvas)
    if (this.disposed) {
      device.destroy()
      throw new Error('CanvasStage is disposed')
    }
    this.gpu = new StageGpu(device, format)
    this.frame = new StageFrame(this.gpu, context, this.canvas)
    // 设备丢失或出现校验错误后画面不再可信，交给调用方决定是否改用回退实现。
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed')
        this.fail(new Error(`WebGPU device lost: ${info.message}`))
    })
    device.addEventListener('uncapturederror', (event) => {
      // GPUError 不是 Error 的子类，包一层，接入方拿到的 onFault 原因才有可读的消息。
      const error = (event as GPUUncapturedErrorEvent).error
      this.fail(new Error(`WebGPU ${error.constructor.name}: ${error.message}`, { cause: error }))
    })

    this.observer = new ResizeObserver(entries => this.observe(entries))
    this.observer.observe(this.canvas)

    this.cssSize = { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
    this.applySize(this.measure())
    this.initialized = true
    return this.snapshot()
  }

  /** 当前画布尺寸、画布倍率与玻璃着色倍率。 */
  getMetrics(): StageMetrics {
    const metrics = this.snapshot()
    return {
      ...metrics,
      glassDpr: this.glassPixelRatio(metrics.dpr),
      optics: this.effectiveOptics(),
    }
  }

  /** 当前的分辨率限制。 */
  getResolution(): StageResolution {
    return { ...this.resolution }
  }

  /** 修改分辨率限制，下一帧生效。 */
  setResolution(resolution: Partial<StageResolution>): void {
    this.resolution = {
      ...this.resolution,
      ...resolution,
    }
    this.adaptive.reset()
    this.glass?.setOptics(this.effectiveOptics())
    this.requestResize()
    this.invalidate()
  }

  /** 配置的光路计算方式。自适应降级期间实际使用的光路见 `getMetrics().optics`。 */
  getOptics(): GlassOptics {
    return this.optics
  }

  /** 切换光路计算方式，下一帧生效。 */
  setOptics(optics: GlassOptics): void {
    this.optics = optics
    this.adaptive.setRelaxable(optics !== 'profile')
    this.glass?.setOptics(this.effectiveOptics())
    this.invalidate()
  }

  /** 固定玻璃主题，传入 null 恢复跟随页面。 */
  setTheme(theme: GlassTheme | null): void {
    this.theme = theme
    this.glass?.setTheme(theme)
  }

  start(root: HTMLElement): void {
    if (!this.initialized)
      throw new Error('CanvasStage.init() must resolve before start()')
    if (this.disposed)
      throw new Error('CanvasStage is disposed')
    if (!this.canvas.contains(root))
      throw new Error('CanvasStage root must be a descendant of the stage canvas')

    this.root = root
    root.setAttribute('drawable', '')
    this.canvas.addEventListener('paint', this.handlePaint)
    root.addEventListener('scroll', this.handleInvalidate, { capture: true, passive: true })
    root.addEventListener('scrollend', this.handleInvalidate, { capture: true, passive: true })
    root.addEventListener('load', this.handleInvalidate, { capture: true })
    if (typeof document !== 'undefined' && document.fonts)
      void document.fonts.ready.then(() => this.invalidate()).catch(() => {})

    this.canvas.updateElementGeometry(root, {
      canvasTransform: new DOMMatrix(),
    })

    const gpu = this.gpu
    if (gpu) {
      this.glass = new LiquidGlassLayer({
        canvas: this.canvas,
        root,
        gpu,
        getBackdrop: () => this.page,
        theme: this.theme,
        optics: this.effectiveOptics(),
        onInvalidate: () => this.invalidate(),
        onFault: cause => this.fail(cause),
      })
      this.glass.start()
      const foreground = root.querySelector<HTMLElement>(attr(STAGE_OVERLAY_ATTR))
      if (foreground)
        this.overlay = new CanvasOverlay(this.canvas, foreground, gpu)
      if (this.frame) {
        this.frame.glass = this.glass
        this.frame.overlay = this.overlay
      }
    }
    this.videoClock.attach(root)
    this.invalidate()
  }

  invalidate(): void {
    if (this.disposed || this.failed || !this.initialized)
      return
    this.canvas.requestPaint()
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true

    this.canvas.removeEventListener('paint', this.handlePaint)
    const root = this.root
    if (root) {
      root.removeEventListener('scroll', this.handleInvalidate, { capture: true })
      root.removeEventListener('scrollend', this.handleInvalidate, { capture: true })
      root.removeEventListener('load', this.handleInvalidate, { capture: true })
      this.canvas.clearElementGeometry(root)
    }
    this.videoClock.detach()
    this.frameProbe.stop()

    this.overlay?.dispose()
    this.overlay = null
    this.glass?.dispose()
    this.glass = null
    this.observer?.disconnect()
    this.observer = null
    this.root = null

    disposeElementTexture(this.page)
    this.page = null

    const gpu = this.gpu
    this.gpu = null
    this.frame = null
    this.initialized = false
    if (gpu) {
      gpu.dispose()
      gpu.device.destroy()
    }
  }

  /** 记录不可恢复的错误并停止绘制，只通知一次。 */
  private fail(cause: unknown): void {
    if (this.failed || this.disposed)
      return
    this.failed = true
    this.onFault(cause)
  }

  private readonly handlePaint = (event: Event): void => {
    this.draw(event)
  }

  private readonly handleInvalidate = (): void => {
    this.invalidate()
  }

  private draw(event?: Event): void {
    if (this.failed || this.disposed)
      return

    const pending = this.pendingSize
    // Resize inside paint so the canvas is not cleared in a separate frame.
    if (pending && this.applySize(pending))
      this.pendingSize = null

    const frame = this.frame
    const page = this.page
    const root = this.root
    if (!frame || !page || !root)
      return

    if (this.resolution.adaptive && this.adaptive.sample(performance.now(), this.frameProbe.mark()))
      this.glass?.setOptics(this.effectiveOptics())

    try {
      const dpr = this.metrics?.dpr ?? 1
      frame.draw(root, page, this.glassPixelRatio(dpr) / dpr, event)
    }
    catch (cause) {
      this.fail(cause)
    }
  }

  private observe(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1]
    if (!entry)
      return

    this.cssSize = { width: entry.contentRect.width, height: entry.contentRect.height }
    this.requestResize()
  }

  /** 按当前 CSS 尺寸与分辨率限制重新计算画布尺寸，有变化时在下一次绘制中应用。 */
  private requestResize(): void {
    if (!this.initialized || this.disposed)
      return
    const next = this.measure()

    if (this.metrics && sameSize(this.metrics, next)) {
      this.pendingSize = null
      return
    }
    if (this.pendingSize && sameSize(this.pendingSize, next))
      return

    this.pendingSize = next
    this.invalidate()
  }

  private applySize(size: StageMetrics): boolean {
    const gpu = this.gpu
    if (!gpu)
      return false
    if (size.pixelWidth < 1 || size.pixelHeight < 1)
      return false
    if (this.metrics && sameSize(this.metrics, size))
      return true

    // 画布尺寸变化后浏览器会换一张画布纹理，配置保持不变。
    this.canvas.width = size.pixelWidth
    this.canvas.height = size.pixelHeight

    const previous = this.page
    this.page = createElementTexture(gpu, size.pixelWidth, size.pixelHeight)
    disposeElementTexture(previous)
    this.glass?.invalidateSizes()

    this.metrics = size

    if (this.root) {
      this.canvas.updateElementGeometry(this.root, {
        canvasTransform: new DOMMatrix(),
      })
    }
    return true
  }

  private measure(): StageMetrics {
    const { width, height } = this.cssSize
    const devicePixelRatio = typeof window === 'undefined'
      ? 1
      : window.devicePixelRatio || 1
    const dpr = resolvePixelRatio({
      devicePixelRatio,
      cssWidth: width,
      cssHeight: height,
      resolution: this.resolution,
    })
    return {
      cssWidth: width,
      cssHeight: height,
      pixelWidth: Math.max(1, Math.round(width * dpr)),
      pixelHeight: Math.max(1, Math.round(height * dpr)),
      dpr,
      glassDpr: this.glassPixelRatio(dpr),
      optics: this.effectiveOptics(),
    }
  }

  /** 实际使用的光路：自适应降级把光路降为查表时是 `profile`，否则是配置的光路。 */
  private effectiveOptics(): GlassOptics {
    return this.resolution.adaptive && this.adaptive.relaxed
      ? 'profile'
      : this.optics
  }

  /** 玻璃体积当前的着色倍率。 */
  private glassPixelRatio(dpr: number): number {
    return resolveGlassPixelRatio(dpr, this.resolution.maxGlassPixelRatio, this.resolution.adaptive
      ? this.adaptive.scale
      : 1)
  }

  private snapshot(): StageMetrics {
    return this.metrics ?? this.measure()
  }
}
