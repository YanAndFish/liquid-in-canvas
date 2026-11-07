import type { StageMetrics } from './types'
import {
  BufferGeometry,
  ExternalTexture,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu'

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

export class CanvasStage {
  private readonly canvas: HTMLCanvasElement
  private readonly onFault: (cause: unknown) => void
  private renderer: WebGPURenderer | null = null
  private device: GPUDevice | null = null
  private material: MeshBasicMaterial | null = null
  private geometry: BufferGeometry | null = null
  private scene: Scene | null = null
  private camera: OrthographicCamera | null = null
  private texture: GPUTexture | null = null
  private external: ExternalTexture | null = null
  private observer: ResizeObserver | null = null
  private root: HTMLElement | null = null
  private metrics: StageMetrics | null = null
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

    const renderer = new WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: false })
    try {
      await renderer.init()
      if (!isWebGPUBackend(renderer.backend))
        throw new Error('WebGPU backend unavailable')

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
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
    geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2))
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
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
    this.applySize(cssWidth, cssHeight, Math.round(cssWidth * dpr), Math.round(cssHeight * dpr))
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
    root.addEventListener('load', this.handleInvalidate, { capture: true })
    if (typeof document !== 'undefined' && document.fonts)
      void document.fonts.ready.then(() => this.invalidate()).catch(() => {})

    this.canvas.updateElementGeometry(root, {
      canvasTransform: new DOMMatrix(),
    })
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
      root.removeEventListener('load', this.handleInvalidate, { capture: true })
      this.canvas.clearElementGeometry(root)
    }

    this.observer?.disconnect()
    this.observer = null
    this.root = null

    this.external?.dispose()
    this.external = null
    this.texture?.destroy()
    this.texture = null
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

  private readonly handlePaint = (): void => {
    this.draw()
  }

  private readonly handleInvalidate = (): void => {
    this.invalidate()
  }

  private draw(): void {
    if (this.failed || this.disposed)
      return

    const device = this.device
    const texture = this.texture
    const root = this.root
    const renderer = this.renderer
    const scene = this.scene
    const camera = this.camera
    if (!device || !texture || !root || !renderer || !scene || !camera)
      return

    try {
      device.queue.drawElementImageToTexture(
        { source: root },
        {
          texture,
          size: { width: texture.width, height: texture.height },
          colorSpace: 'srgb',
        },
      )
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
    const pixelWidth = Math.max(1, Math.round(entry.contentRect.width * dpr))
    const pixelHeight = Math.max(1, Math.round(entry.contentRect.height * dpr))
    this.applySize(entry.contentRect.width, entry.contentRect.height, pixelWidth, pixelHeight)
  }

  private applySize(cssWidth: number, cssHeight: number, pixelWidth: number, pixelHeight: number): void {
    const renderer = this.renderer
    const device = this.device
    const material = this.material
    if (!renderer || !device || !material)
      return
    if (pixelWidth < 1 || pixelHeight < 1)
      return
    if (this.metrics
      && this.metrics.cssWidth === cssWidth
      && this.metrics.cssHeight === cssHeight
      && this.metrics.pixelWidth === pixelWidth
      && this.metrics.pixelHeight === pixelHeight) {
      return
    }

    renderer.setSize(pixelWidth, pixelHeight, false)

    const oldExternal = this.external
    const oldTexture = this.texture
    const texture = device.createTexture({
      size: { width: pixelWidth, height: pixelHeight },
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const external = new ExternalTexture(texture)
    external.colorSpace = SRGBColorSpace

    this.texture = texture
    this.external = external
    material.map = external
    material.needsUpdate = true

    oldExternal?.dispose()
    oldTexture?.destroy()

    this.metrics = {
      cssWidth,
      cssHeight,
      pixelWidth,
      pixelHeight,
      dpr: this.pixelRatio(),
    }

    if (this.root) {
      this.canvas.updateElementGeometry(this.root, {
        canvasTransform: new DOMMatrix(),
      })
    }
    this.invalidate()
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
}
