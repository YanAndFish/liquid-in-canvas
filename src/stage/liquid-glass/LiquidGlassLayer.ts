import type { Scene, WebGPURenderer } from 'three/webgpu'
import type { GlassMaterialHandle } from './material'
import type { GlassOptions } from './options'
import { ExternalTexture, Mesh, PlaneGeometry, SRGBColorSpace, Vector2 } from 'three/webgpu'
import { BackdropBlur } from './blur'
import { createGlassMaterial } from './material'
import { glassOptionsSignature, parseGlassOptions } from './options'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface GlassSurface {
  element: HTMLElement
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string
  material: GlassMaterialHandle
  mesh: Mesh
  texture: GPUTexture | null
  external: ExternalTexture | null
  textureWidth: number
  textureHeight: number
  lastGeometry: Rect | null
  dirty: boolean
  settleFrames: number
  wasVisible: boolean
  addedDrawable: boolean
  resizeObserver: ResizeObserver | null
  retryTimer: number | null
  onScroll: () => void
  onTransitionEnd: () => void
}

export interface LiquidGlassLayerOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement
  scene: Scene
  device: GPUDevice
  renderer: WebGPURenderer
  getBackdrop: () => ExternalTexture | null
  onInvalidate: () => void
  onFault: (cause: unknown) => void
}

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
  private readonly scene: Scene
  private readonly device: GPUDevice
  private readonly renderer: WebGPURenderer
  private readonly getBackdrop: () => ExternalTexture | null
  private readonly onInvalidate: () => void
  private readonly onFault: (cause: unknown) => void
  private readonly surfaces = new Map<HTMLElement, GlassSurface>()
  private readonly geometry = new PlaneGeometry(1, 1)
  private readonly viewport = new Vector2(1, 1)
  private observer: MutationObserver | null = null
  private themeObserver: MutationObserver | null = null
  private blur: BackdropBlur | null = null
  private started = false
  private disposed = false

  constructor(options: LiquidGlassLayerOptions) {
    this.canvas = options.canvas
    this.root = options.root
    this.scene = options.scene
    this.device = options.device
    this.renderer = options.renderer
    this.getBackdrop = options.getBackdrop
    this.onInvalidate = options.onInvalidate
    this.onFault = options.onFault
  }

  start(): void {
    if (this.started || this.disposed)
      return
    if (typeof this.canvas.updateElementGeometry !== 'function' || typeof this.canvas.getElementImageDefaultSize !== 'function')
      return

    this.started = true
    this.viewport.set(this.canvas.clientWidth, this.canvas.clientHeight)
    this.observer = new MutationObserver(records => this.handleMutations(records))
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.themeObserver = new MutationObserver(() => this.refreshAll())
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const backdrop = this.getBackdrop()
    if (backdrop)
      this.blur = new BackdropBlur(this.renderer, backdrop)
    window.addEventListener('resize', this.handleWindowResize, { passive: true })
    this.scan()
  }

  setBackdrop(texture: ExternalTexture): void {
    for (const surface of this.surfaces.values())
      surface.material.setBackdrop(texture)
    this.onInvalidate()
  }

  sync(event?: Event): void {
    if (!this.started || this.disposed)
      return
    this.viewport.set(this.canvas.clientWidth, this.canvas.clientHeight)
    if (this.viewport.x < 1 || this.viewport.y < 1)
      return

    const changed = (event as PaintEventLike | undefined)?.changedElements ?? []
    const modal = this.modalFactor()
    let visibleSurfaces = 0
    for (const surface of [
      ...this.surfaces.values(),
    ]) {
      if (!surface.element.isConnected) {
        this.unregister(surface)
        continue
      }

      const rect = this.measure(surface)
      const size = this.textureSize(surface)
      if (size.width !== surface.textureWidth || size.height !== surface.textureHeight)
        this.resizeSurface(surface, size.width, size.height)

      const anchorRect = surface.anchor?.isConnected
        ? surface.anchor.getBoundingClientRect()
        : null
      const visible = intersects(rect, this.viewport.x, this.viewport.y)
        && (!anchorRect || intersectsRect(rect, anchorRect))
      if (visible)
        visibleSurfaces++
      if (visible && !surface.wasVisible) {
        this.kickPaint(surface.element)
        surface.dirty = true
        surface.settleFrames = 4
      }
      surface.wasVisible = visible
      surface.mesh.visible = visible
      this.placeSurface(surface, rect)
      this.updateGeometry(surface, rect)
      const insideModal = document.getElementById('cart-shell')?.contains(surface.element) ?? false
      surface.material.setOpacity(this.pageOpacity(surface.element) * (insideModal ? 1 : modal))

      if (changed.some(element => surface.element.contains(element)))
        surface.dirty = true

      if (visible && (surface.dirty || surface.settleFrames > 0)) {
        if (this.upload(surface))
          surface.settleFrames = Math.max(0, surface.settleFrames - 1)
        else
          surface.settleFrames = 0
      }
    }

    const backdrop = this.getBackdrop()
    if (this.blur && backdrop && visibleSurfaces > 0)
      this.blur.render(backdrop, this.canvas.width, this.canvas.height)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.themeObserver?.disconnect()
    this.themeObserver = null
    window.removeEventListener('resize', this.handleWindowResize)
    for (const surface of [
      ...this.surfaces.values(),
    ])
      this.unregister(surface)
    this.surfaces.clear()
    this.blur?.dispose()
    this.blur = null
    this.geometry.dispose()
  }

  private scan(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-liquid-glass]'))
      this.register(element)
  }

  private register(element: HTMLElement): void {
    if (this.surfaces.has(element) || !element.isConnected || !this.root.contains(element))
      return
    if (element.parentElement?.closest('[data-liquid-glass]'))
      return

    const options = parseGlassOptions(element, this.theme())
    const anchor = this.resolveAnchor(element, options)
    const initial = this.domMeasure(element, anchor)
    if (!initial.width || !initial.height)
      return

    const backdrop = this.getBackdrop()
    const blur = this.blur
    if (!backdrop || !blur)
      return

    const size = this.textureSize(element)
    const content = this.createContentTexture(size.width, size.height)
    if (!content)
      return

    const addedDrawable = !element.hasAttribute('drawable')
    if (addedDrawable)
      element.setAttribute('drawable', '')

    this.canvas.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix().translate(initial.left, initial.top),
    })

    const material = createGlassMaterial(backdrop, content.external, blur.softTexture, blur.heavyTexture)
    material.setOptions(options)
    const mesh = new Mesh(this.geometry, material.material)
    mesh.frustumCulled = false
    mesh.renderOrder = element.closest('#cart-shell')
      ? 1000
      : 10 + this.surfaces.size
    mesh.visible = false
    this.scene.add(mesh)

    const surface: GlassSurface = {
      element,
      anchor,
      options,
      signature: glassOptionsSignature(options),
      material,
      mesh,
      texture: content.texture,
      external: content.external,
      textureWidth: size.width,
      textureHeight: size.height,
      lastGeometry: null,
      dirty: true,
      settleFrames: 4,
      wasVisible: false,
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

    surface.resizeObserver = new ResizeObserver(() => {
      surface.dirty = true
      this.onInvalidate()
    })
    surface.resizeObserver.observe(element)
    element.addEventListener('scroll', surface.onScroll, { capture: true, passive: true })
    element.addEventListener('transitionend', surface.onTransitionEnd)

    this.surfaces.set(element, surface)
    this.placeSurface(surface, initial)
    this.updateGeometry(surface, initial)
    this.onInvalidate()
  }

  private unregister(surface: GlassSurface): void {
    if (!this.surfaces.has(surface.element))
      return
    this.surfaces.delete(surface.element)
    surface.resizeObserver?.disconnect()
    if (surface.retryTimer !== null) {
      window.clearTimeout(surface.retryTimer)
      surface.retryTimer = null
    }
    surface.element.removeEventListener('scroll', surface.onScroll, { capture: true })
    surface.element.removeEventListener('transitionend', surface.onTransitionEnd)
    if (typeof this.canvas.clearElementGeometry === 'function')
      this.canvas.clearElementGeometry(surface.element)
    if (surface.addedDrawable)
      surface.element.removeAttribute('drawable')
    this.scene.remove(surface.mesh)
    surface.material.dispose()
    surface.external?.dispose()
    surface.texture?.destroy()
    surface.texture = null
    surface.external = null
    this.onInvalidate()
  }

  private readonly handleWindowResize = (): void => {
    this.scan()
    this.onInvalidate()
  }

  private handleMutations(records: MutationRecord[]): void {
    let invalidated = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as HTMLElement
        const name = record.attributeName ?? ''
        if (name === 'data-liquid-glass') {
          if (target.hasAttribute('data-liquid-glass')) {
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
          const glass = target.closest<HTMLElement>('[data-liquid-glass]')
          if (glass && !this.surfaces.has(glass))
            this.register(glass)
        }
        continue
      }

      if (record.type === 'childList') {
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
    if (node.matches('[data-liquid-glass]'))
      this.register(node)
    for (const element of node.querySelectorAll<HTMLElement>('[data-liquid-glass]'))
      this.register(element)
  }

  private surfaceOwner(element: HTMLElement | null): GlassSurface | null {
    let current = element
    while (current) {
      const surface = this.surfaces.get(current)
      if (surface)
        return surface
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
    surface.material.setOptions(options)
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

  private domMeasure(element: HTMLElement, anchor: HTMLElement | null): Rect {
    if (anchor) {
      const base = anchor.getBoundingClientRect()
      return {
        left: base.left + element.offsetLeft - anchor.scrollLeft,
        top: base.top + element.offsetTop - anchor.scrollTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }
    }
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
  }

  private measure(surface: GlassSurface): Rect {
    const element = surface.element
    const anchor = surface.anchor
    if (anchor?.isConnected) {
      const base = anchor.getBoundingClientRect()
      return {
        left: base.left + element.offsetLeft - anchor.scrollLeft,
        top: base.top + element.offsetTop - anchor.scrollTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }
    }
    const parent = element.offsetParent
    if (parent instanceof HTMLElement) {
      const base = parent.getBoundingClientRect()
      return {
        left: base.left + element.offsetLeft - parent.scrollLeft,
        top: base.top + element.offsetTop - parent.scrollTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }
    }
    return {
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    }
  }

  private placeSurface(surface: GlassSurface, rect: Rect): void {
    if (this.viewport.x < 1 || this.viewport.y < 1)
      return
    const padding = Math.max(surface.options.shadowSize, 0) + 2
    const left = rect.left - padding
    const top = rect.top - padding
    const width = rect.width + padding * 2
    const height = rect.height + padding * 2
    surface.mesh.position.set(
      ((left + width / 2) / this.viewport.x) * 2 - 1,
      1 - ((top + height / 2) / this.viewport.y) * 2,
      0,
    )
    surface.mesh.scale.set(
      (width / this.viewport.x) * 2,
      (height / this.viewport.y) * 2,
      1,
    )
    surface.material.setPanel(
      new Vector2(rect.width, rect.height),
      new Vector2(width, height),
      this.viewport,
    )
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

  private kickPaint(element: HTMLElement): void {
    // A drawable element that first appears outside the viewport can carry an empty
    // paint record. A transparent shadow forces the subtree to be painted.
    element.style.boxShadow = '0 0 0 1px rgba(0, 0, 0, 0)'
  }

  private modalFactor(): number {
    const shell = document.getElementById('cart-shell')
    const scrim = shell?.querySelector<HTMLElement>('[data-glass-scrim]')
    if (!shell || !scrim)
      return 1
    const shellOpacity = Number.parseFloat(getComputedStyle(shell).opacity)
    const opacity = Number.isFinite(shellOpacity)
      ? shellOpacity
      : 1
    return 1 - colorAlpha(getComputedStyle(scrim).backgroundColor) * opacity
  }

  private pageOpacity(element: HTMLElement): number {
    const page = element.closest('.page-view')
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

  private createContentTexture(width: number, height: number): { texture: GPUTexture, external: ExternalTexture } | null {
    try {
      const texture = this.device.createTexture({
        size: { width, height },
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      const external = new ExternalTexture(texture)
      external.colorSpace = SRGBColorSpace
      return { texture, external }
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
    surface.material.setContent(content.external)
    surface.external?.dispose()
    surface.texture?.destroy()
    surface.external = content.external
    surface.texture = content.texture
    surface.textureWidth = width
    surface.textureHeight = height
    surface.dirty = true
  }

  private upload(surface: GlassSurface): boolean {
    if (!surface.texture)
      return false
    try {
      this.device.queue.drawElementImageToTexture(
        { source: surface.element },
        {
          texture: surface.texture,
          size: { width: surface.texture.width, height: surface.texture.height },
          colorSpace: 'srgb',
        },
      )
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
      this.onInvalidate()
    }, 180)
  }

  private theme(): 'light' | 'dark' {
    if (typeof document === 'undefined')
      return 'dark'
    return document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark'
  }
}
