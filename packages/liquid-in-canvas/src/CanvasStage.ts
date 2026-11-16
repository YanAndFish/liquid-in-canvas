import type { ElementTexture } from './gpu'
import type { GlassTheme } from './liquid-glass/defaults'
import type { GlassOptics, StageMetrics, StageResolution } from './types'
import { AdaptiveScale } from './adaptive.hot'
import { CanvasOverlay } from './CanvasOverlay.hot'
import { attr, STAGE_OVERLAY_ATTR } from './contract'
import { FrameProbe } from './frame-probe.hot'
import { createElementTexture, createStageDevice, disposeElementTexture, StageGpu } from './gpu'
import { LiquidGlassLayer } from './liquid-glass/LiquidGlassLayer'
import { DEFAULT_STAGE_RESOLUTION, resolveCanvasScaleFloor, resolveGlassPixelRatio, resolvePixelRatio } from './resolution'
import { snapshotChanged, StageFrame } from './stage-frame.hot'
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
  /** 光路计算方式，缺省为 `hybrid`，见 `GlassOptics`。 */
  optics?: GlassOptics
  /**
   * `hybrid` 光路是否缓存连接处的折射场，缺省为 true。打开时，几何静止的融合组只求交一次，
   * 之后每帧读回折射场再取样背景；成员相对运动、按压或迁移期间这一组改用查表，停下约 0.1 秒后求交并淡入。
   * 关闭后连接处每帧逐步求交，运动中也与 `raymarch` 一致，开销随连接处的面积增加。
   */
  fieldCache?: boolean
  /**
   * 实验开关，缺省为 false：页面没有变化的帧沿用上一帧的整页快照，不再调用 `drawElementImageToTexture()`。
   * “没有变化”指 `paint` 事件的 `changedElements` 里没有根元素，而且上一次上传之后没有发生滚动、
   * 资源加载、字体就绪、视频新帧、尺寸变化或外部调用 `invalidate()`。只有玻璃自己在动的帧
   * （按压弹簧、液体迁移、折射场缓存的淡化）因此省掉整页光栅化；滚动和视频播放期间每帧照常上传。
   * 依赖浏览器正确报告 `changedElements`，见 `docs/performance/2026-11-16-local-snapshot/README.md`。
   */
  snapshotReuse?: boolean
}

/** 开始绘制或修改分辨率限制后这么多毫秒内不做自适应判定：页面刚开始绘制时图片解码、字体加载会拖慢几帧，不代表常态。 */
const ADAPTIVE_WARMUP = 2000

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
  /** 是否在页面没有变化的帧沿用上一帧快照，见 `CanvasStageOptions.snapshotReuse`。 */
  private snapshotReuse: boolean
  /** 上一次上传之后舞台自己知道页面可能变了（滚动、加载、尺寸、视频帧等），下一帧必须上传。 */
  private pageStale = true
  /** 这个时间之前不把绘制间隔交给自适应降级。 */
  private adaptiveAfter = 0
  private theme: GlassTheme | null
  private optics: GlassOptics
  private fieldCache: boolean
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
    this.optics = options.optics ?? 'hybrid'
    this.fieldCache = options.fieldCache ?? true
    this.snapshotReuse = options.snapshotReuse ?? false
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
    this.adaptiveAfter = performance.now() + ADAPTIVE_WARMUP
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
    this.requestFrame()
  }

  /** 打开或关闭 `hybrid` 光路的折射场缓存，下一帧生效。见 `CanvasStageOptions.fieldCache`。 */
  setFieldCache(enabled: boolean): void {
    this.fieldCache = enabled
    this.glass?.setFieldCache(enabled)
    this.requestFrame()
  }

  /** 打开或关闭快照复用，下一帧生效。见 `CanvasStageOptions.snapshotReuse`。 */
  setSnapshotReuse(enabled: boolean): void {
    this.snapshotReuse = enabled
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
    this.adaptiveAfter = performance.now() + ADAPTIVE_WARMUP
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
        fieldCache: this.fieldCache,
        onInvalidate: () => this.invalidate(),
        // 玻璃自己的运动不改变页面，只请求重绘；快照复用打开时这些帧沿用上一帧快照。
        onRedraw: () => this.requestFrame(),
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

  /** 页面可能有浏览器察觉不到的变化时调用：下一帧重新上传整页快照并重绘。 */
  invalidate(): void {
    this.pageStale = true
    this.requestFrame()
  }

  /** 只请求重绘，不认为页面变了。 */
  private requestFrame(): void {
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

    // 自适应降级可能改变光路、玻璃着色倍率或画布倍率；画布尺寸的变化与其他来源的一样，在这一帧里应用。
    // 探针在预热期间也要计数，预热结束后的第一次取样才知道它是否紧接着上一个显示帧。
    const now = performance.now()
    if (this.root && this.resolution.adaptive) {
      const continuous = this.frameProbe.mark()
      if (now >= this.adaptiveAfter && this.adaptive.sample(now, continuous)) {
        this.glass?.setOptics(this.effectiveOptics())
        this.requestResize()
      }
    }

    const pending = this.pendingSize
    // Resize inside paint so the canvas is not cleared in a separate frame.
    if (pending && this.applySize(pending))
      this.pendingSize = null

    const frame = this.frame
    const page = this.page
    const root = this.root
    if (!frame || !page || !root)
      return

    try {
      const dpr = this.metrics?.dpr ?? 1
      const upload = !this.snapshotReuse || this.pageStale || snapshotChanged(event, root)
      this.pageStale = false
      frame.draw(root, page, this.glassPixelRatio(dpr) / dpr, event, upload)
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
    this.pageStale = true
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
    const base = resolvePixelRatio({
      devicePixelRatio,
      cssWidth: width,
      cssHeight: height,
      resolution: this.resolution,
    })
    // 静态上限给出的倍率再乘以自适应降级的系数；系数的下限随设备倍率与窗口尺寸变化，每次重新计算。
    this.adaptive.setCanvasFloor(resolveCanvasScaleFloor(devicePixelRatio, base, this.resolution.minPixelRatio))
    const dpr = this.resolution.adaptive
      ? base * this.adaptive.canvasScale
      : base
    return {
      cssWidth: width,
      cssHeight: height,
      pixelWidth: Math.max(1, Math.round(width * dpr)),
      pixelHeight: Math.max(1, Math.round(height * dpr)),
      dpr,
      targetDpr: base,
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
