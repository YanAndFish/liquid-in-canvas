import type { BufferGeometry } from 'three/webgpu'
import type { ElementTexture } from './gpu'
import type { StageMetrics } from './types'
import {
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import { CanvasOverlay } from './CanvasOverlay'
import { attr, STAGE_OVERLAY_ATTR } from './contract'
import { createElementTexture, createFullscreenTriangle, createSrgbCanvasOutput, disposeElementTexture, uploadElement } from './gpu'
import { LiquidGlassLayer } from './liquid-glass/LiquidGlassLayer'
import { PAGE_RENDER_ORDER } from './render-order'

interface CanvasStageOptions {
  canvas: HTMLCanvasElement
  onFault: (cause: unknown) => void
}

interface WebGPUBackendLike {
  isWebGPUBackend: true
  device: GPUDevice | null
}

function isWebGPUBackend(backend: unknown): backend is WebGPUBackendLike {
  return typeof backend === 'object'
    && backend !== null
    && 'isWebGPUBackend' in backend
    && backend.isWebGPUBackend === true
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
  private renderer: WebGPURenderer | null = null
  private device: GPUDevice | null = null
  private material: MeshBasicMaterial | null = null
  private geometry: BufferGeometry | null = null
  private scene: Scene | null = null
  private camera: OrthographicCamera | null = null
  /** 整页快照，同时作为玻璃折射与模糊的背景。 */
  private page: ElementTexture | null = null
  private observer: ResizeObserver | null = null
  private root: HTMLElement | null = null
  private overlay: CanvasOverlay | null = null
  private glass: LiquidGlassLayer | null = null
  private metrics: StageMetrics | null = null
  private pendingSize: StageMetrics | null = null
  private playingVideos = new Set<HTMLVideoElement>()
  private videoFrame: number | null = null
  private initialized = false
  private failed = false
  private disposed = false

  constructor(options: CanvasStageOptions) {
    this.canvas = options.canvas
    this.onFault = options.onFault
  }

  async init(): Promise<StageMetrics> {
    if (this.initialized)
      return this.snapshot()

    if (this.canvas.content !== 'drawable')
      this.canvas.setAttribute('content', 'drawable')

    const output = createSrgbCanvasOutput(this.canvas)
    const renderer = new WebGPURenderer({
      canvas: this.canvas,
      context: output?.context,
      antialias: false,
      alpha: false,
    })
    try {
      await renderer.init()
      if (!isWebGPUBackend(renderer.backend))
        throw new Error('WebGPU backend unavailable')

      output?.attach(renderer)
      renderer.setPixelRatio(1)
      renderer.getContext()

      const device = renderer.backend.device
      if (!device)
        throw new Error('WebGPU device unavailable')

      this.renderer = renderer
      this.device = device
    }
    catch (cause) {
      await renderer.dispose().catch(() => {})
      throw cause
    }

    const material = new MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false })
    const geometry = createFullscreenTriangle()
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = PAGE_RENDER_ORDER
    const scene = new Scene()
    scene.add(mesh)

    this.material = material
    this.geometry = geometry
    this.scene = scene
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

    this.observer = new ResizeObserver(entries => this.observe(entries))
    this.observer.observe(this.canvas)

    const dpr = this.pixelRatio()
    const cssWidth = this.canvas.clientWidth
    const cssHeight = this.canvas.clientHeight
    this.applySize({
      cssWidth,
      cssHeight,
      pixelWidth: Math.round(cssWidth * dpr),
      pixelHeight: Math.round(cssHeight * dpr),
      dpr,
    })
    this.initialized = true
    return this.snapshot()
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

    const scene = this.scene
    const device = this.device
    const renderer = this.renderer
    if (scene && device && renderer) {
      this.glass = new LiquidGlassLayer({
        canvas: this.canvas,
        root,
        scene,
        device,
        renderer,
        getBackdrop: () => this.page?.external ?? null,
        onInvalidate: () => this.invalidate(),
        onFault: (cause) => {
          this.failed = true
          this.onFault(cause)
        },
      })
      this.glass.start()
      const foreground = root.querySelector<HTMLElement>(attr(STAGE_OVERLAY_ATTR))
      if (foreground && this.geometry)
        this.overlay = new CanvasOverlay(this.canvas, foreground, device, scene, this.geometry)
    }
    this.attachVideoClock(root)
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
      this.detachVideoClock(root)
    }

    this.overlay?.dispose()
    this.overlay = null
    this.glass?.dispose()
    this.glass = null
    this.observer?.disconnect()
    this.observer = null
    this.root = null

    disposeElementTexture(this.page)
    this.page = null
    this.material?.dispose()
    this.material = null
    this.geometry?.dispose()
    this.geometry = null
    this.scene = null
    this.camera = null

    const renderer = this.renderer
    this.renderer = null
    this.device = null
    this.initialized = false
    if (renderer)
      void renderer.dispose()
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

    const device = this.device
    const page = this.page
    const root = this.root
    const renderer = this.renderer
    const scene = this.scene
    const camera = this.camera
    if (!device || !page || !root || !renderer || !scene || !camera)
      return

    try {
      // 帧流水线：页面快照 → 玻璃（内容遮挡、模糊、体积）→ 前景 → 合成。
      uploadElement(device, root, page.texture)
      this.glass?.sync(event)
      this.overlay?.sync()
      renderer.render(scene, camera)
    }
    catch (cause) {
      this.failed = true
      this.onFault(cause)
    }
  }

  private observe(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1]
    if (!entry)
      return

    const dpr = this.pixelRatio()
    const next: StageMetrics = {
      cssWidth: entry.contentRect.width,
      cssHeight: entry.contentRect.height,
      pixelWidth: Math.max(1, Math.round(entry.contentRect.width * dpr)),
      pixelHeight: Math.max(1, Math.round(entry.contentRect.height * dpr)),
      dpr,
    }

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
    const renderer = this.renderer
    const device = this.device
    const material = this.material
    if (!renderer || !device || !material)
      return false
    if (size.pixelWidth < 1 || size.pixelHeight < 1)
      return false
    if (this.metrics && sameSize(this.metrics, size))
      return true

    renderer.setSize(size.pixelWidth, size.pixelHeight, false)

    const previous = this.page
    const page = createElementTexture(device, size.pixelWidth, size.pixelHeight)
    this.page = page
    material.map = page.external
    material.needsUpdate = true
    disposeElementTexture(previous)

    this.metrics = size

    if (this.root) {
      this.canvas.updateElementGeometry(this.root, {
        canvasTransform: new DOMMatrix(),
      })
    }
    return true
  }

  private pixelRatio(): number {
    return typeof window === 'undefined'
      ? 1
      : window.devicePixelRatio || 1
  }

  private snapshot(): StageMetrics {
    return this.metrics ?? {
      cssWidth: 0,
      cssHeight: 0,
      pixelWidth: 0,
      pixelHeight: 0,
      dpr: this.pixelRatio(),
    }
  }

  private attachVideoClock(root: HTMLElement): void {
    root.addEventListener('play', this.handleVideoPlay, true)
    root.addEventListener('pause', this.handleVideoPause, true)
    root.addEventListener('ended', this.handleVideoPause, true)
    root.addEventListener('seeked', this.handleInvalidate, true)
    for (const video of root.querySelectorAll('video')) {
      if (!video.paused)
        this.playingVideos.add(video)
    }
    if (this.playingVideos.size)
      this.scheduleVideoFrame()
  }

  private detachVideoClock(root: HTMLElement): void {
    root.removeEventListener('play', this.handleVideoPlay, true)
    root.removeEventListener('pause', this.handleVideoPause, true)
    root.removeEventListener('ended', this.handleVideoPause, true)
    root.removeEventListener('seeked', this.handleInvalidate, true)
    this.playingVideos.clear()
    if (this.videoFrame !== null) {
      cancelAnimationFrame(this.videoFrame)
      this.videoFrame = null
    }
  }

  private readonly handleVideoPlay = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement))
      return
    this.playingVideos.add(event.target)
    this.scheduleVideoFrame()
  }

  private readonly handleVideoPause = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement))
      return
    this.playingVideos.delete(event.target)
    if (!this.playingVideos.size && this.videoFrame !== null) {
      cancelAnimationFrame(this.videoFrame)
      this.videoFrame = null
    }
  }

  private scheduleVideoFrame(): void {
    if (this.videoFrame !== null || this.disposed)
      return
    this.videoFrame = requestAnimationFrame(this.tickVideo)
  }

  private readonly tickVideo = (): void => {
    this.videoFrame = null
    for (const video of this.playingVideos) {
      if (!video.isConnected || video.paused)
        this.playingVideos.delete(video)
    }
    if (this.disposed || !this.playingVideos.size)
      return
    this.invalidate()
    this.videoFrame = requestAnimationFrame(this.tickVideo)
  }
}
