import type { DrawList } from '../frame.hot'
import type { ElementTexture, SampledTexture, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { GlassTheme } from './defaults'
import type { GlassFrameHost } from './glass-frame.hot'
import type { GlassOptions } from './options'
import type { GlassGhost, GlassSurface, Rect, UnderContent } from './surface'
import { attr, GLASS_ATTR, GLASS_PLACE_ATTR, hasAttr } from '../contract'
import { createElementTexture, disposeElementTexture } from '../gpu'
import { reducedMotionQuery } from '../shared/motion'
import { onGlassDefaultsChange } from './defaults'
import { LiquidFlow } from './flow.hot'
import { GlassFrame } from './glass-frame.hot'
import { glassOptionsSignature, parseGlassOptions } from './options'
import { createSurface, createUnderContent } from './surface'
import { GlassThemeSource } from './theme'

export interface LiquidGlassLayerOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement
  gpu: StageGpu
  getBackdrop: () => SampledTexture | null
  theme?: GlassTheme | null
  optics?: GlassOptics
  fieldCache?: boolean
  onInvalidate: () => void
  onFault: (cause: unknown) => void
}

interface Placement {
  originX: number
  originY: number
  layout: Rect
  rect: Rect
}

interface PaintEventLike extends Event {
  changedElements?: readonly Element[]
}

const HANDOVER_WINDOW = 400
const WARM_VOLUME_COUNTS = [1, 2, 3, 4]
const WARM_OCCLUDER_COUNTS = [0, 1, 2]
const GLASS_SELECTOR = attr(GLASS_ATTR)
const UNDER_SELECTOR = `[${GLASS_PLACE_ATTR}="below"]`
const NO_ELEMENTS: readonly Element[] = []
const UNDER_RETRY_MS = 180

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

export class LiquidGlassLayer implements GlassFrameHost {
  readonly surfaces: GlassSurface[] = []
  readonly ghosts: GlassGhost[] = []
  readonly fading: GlassSurface[] = []
  private nextGhostId = -1_000_000
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly gpu: StageGpu
  private readonly getBackdrop: () => SampledTexture | null
  private readonly onInvalidate: () => void
  private readonly onFault: (cause: unknown) => void
  private readonly byElement = new Map<HTMLElement, GlassSurface>()
  private readonly paintToggle = new WeakSet<HTMLElement>()
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
  private optics: GlassOptics
  private fieldCache: boolean
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
    this.optics = options.optics ?? 'hybrid'
    this.fieldCache = options.fieldCache ?? true
  }

  start(): void {
    if (this.started || this.disposed)
      return
    if (typeof this.canvas.updateElementGeometry !== 'function' || typeof this.canvas.getElementImageDefaultSize !== 'function')
      return

    this.started = true
    this.frame = new GlassFrame(this.canvas, this.root, this.gpu, this)
    this.frame.setShading(this.shadingScale, this.shadingSplit)
    this.frame.setFieldCache(this.fieldCache)
    this.frame.setOptics(this.optics)
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

  sync(event: Event | undefined, list: DrawList): boolean {
    if (!this.started || this.disposed || !this.frame)
      return false
    return this.frame.sync((event as PaintEventLike | undefined)?.changedElements ?? NO_ELEMENTS, list)
  }

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
    while (this.fading.length)
      this.release(this.fading[this.fading.length - 1]!)
    this.departed.clear()
    this.ghosts.length = 0
    this.frame?.dispose()
    this.frame = null
  }

  setTheme(theme: GlassTheme | null): void {
    this.themeSource.set(theme)
  }

  setOptics(optics: GlassOptics): void {
    this.optics = optics
    this.frame?.setOptics(optics)
  }

  setFieldCache(enabled: boolean): void {
    this.fieldCache = enabled
    this.frame?.setFieldCache(enabled)
  }

  setShading(scale: number, split: number): void {
    this.shadingScale = scale
    this.shadingSplit = split
    this.frame?.setShading(scale, split)
  }

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

  release(surface: GlassSurface): void {
    const index = this.fading.indexOf(surface)
    if (index >= 0)
      this.fading.splice(index, 1)
    disposeElementTexture(surface.content)
    surface.content = null
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

  kickPaint(surface: GlassSurface): void {
    const element = surface.element
    surface.paintPending = true
    const alternate = !this.paintToggle.has(element)
    if (alternate)
      this.paintToggle.add(element)
    else
      this.paintToggle.delete(element)
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

  syncUnder(surface: GlassSurface): void {
    surface.underDirty = false
    const under = surface.under
    for (let i = under.length - 1; i >= 0; i--) {
      const item = under[i]!
      if (surface.host || !surface.element.contains(item.element) || !item.element.matches(UNDER_SELECTOR)) {
        this.releaseUnder(item)
        under.splice(i, 1)
      }
    }
    if (surface.host)
      return
    for (const element of surface.element.querySelectorAll<HTMLElement>(UNDER_SELECTOR)) {
      if (under.some(item => item.element === element))
        continue
      const size = this.textureSize(element)
      const content = this.createContentTexture(size.width, size.height)
      if (!content)
        continue
      const addedDrawable = !element.hasAttribute('drawable')
      if (addedDrawable)
        element.setAttribute('drawable', '')
      under.push(createUnderContent(element, content, size.width, size.height, addedDrawable))
    }
    surface.dirty = true
    this.onInvalidate()
  }

  refreshUnderSize(item: UnderContent): void {
    const size = this.textureSize(item.element)
    if (size.width === item.textureWidth && size.height === item.textureHeight)
      return
    const content = this.createContentTexture(size.width, size.height)
    if (!content)
      return
    disposeElementTexture(item.content)
    item.content = content
    item.textureWidth = size.width
    item.textureHeight = size.height
    item.dirty = true
    item.uploaded = false
  }

  uploadUnder(item: UnderContent): boolean {
    if (!item.content)
      return false
    try {
      this.gpu.frame.upload(item.element, item.content.texture)
      item.dirty = false
      item.uploaded = true
      return true
    }
    catch {
      window.setTimeout(this.onInvalidate, UNDER_RETRY_MS)
      return false
    }
  }

  private releaseUnder(item: UnderContent): void {
    if (typeof this.canvas.clearElementGeometry === 'function' && item.placed)
      this.canvas.clearElementGeometry(item.element)
    if (item.addedDrawable)
      item.element.removeAttribute('drawable')
    disposeElementTexture(item.content)
    item.content = null
  }

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
    for (const other of this.surfaces) {
      if (other.partner === surface)
        other.partner = null
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      if (this.ghosts[i]!.target === surface)
        this.ghosts.splice(i, 1)
    }
    const remaining = surface.options.morph && surface.hasVolume && !surface.handedOver && !this.reducedMotion()
      ? this.sameName(surface.options.morph)
      : null
    const fade = !remaining
      && !surface.options.morph
      && surface.host === null
      && surface.options.materialize
      && surface.visible
      && surface.content !== null
      && !this.disposed
      && !this.reducedMotion()
    if (remaining) {
      this.ghosts.push(this.createGhost(surface, remaining))
      this.startAnimation()
    }
    else if (surface.options.morph && surface.hasVolume && !surface.handedOver) {
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
    for (const item of surface.under)
      this.releaseUnder(item)
    surface.under.length = 0
    if (!surface.host && typeof this.canvas.clearElementGeometry === 'function')
      this.canvas.clearElementGeometry(surface.element)
    if (surface.addedDrawable)
      surface.element.removeAttribute('drawable')
    if (this.paintToggle.delete(surface.element) || surface.element.style.boxShadow.includes('rgba(0, 0, 0, 0)'))
      surface.element.style.boxShadow = ''
    if (fade) {
      surface.fading = true
      surface.hiding = false
      surface.hasTail = false
      this.fading.push(surface)
      this.startAnimation()
    }
    else {
      disposeElementTexture(surface.content)
      surface.content = null
    }
    this.onInvalidate()
  }

  private attachFlow(surface: GlassSurface): void {
    const name = surface.options.morph
    surface.inherited = false
    if (name === null) {
      surface.flow = null
      return
    }
    const source = name && !this.reducedMotion()
      ? this.handover(name, surface)
      : null
    if (!source) {
      surface.flow = new LiquidFlow(surface.layout)
      surface.snapFlow = true
      return
    }
    const rect = source.rect
    surface.flow = new LiquidFlow({
      left: rect.left - surface.originX,
      top: rect.top - surface.originY,
      width: rect.width,
      height: rect.height,
    })
    surface.partner = source.partner
    surface.snapFlow = false
    surface.inherited = true
    this.startAnimation()
  }

  private sameName(name: string, except: GlassSurface | null = null): GlassSurface | null {
    for (const other of this.surfaces) {
      if (other !== except && other.options.morph === name && other.hasVolume)
        return other
    }
    return null
  }

  private createGhost(from: GlassSurface, target: GlassSurface): GlassGhost {
    const source = from.volume
    const rect = {
      left: source.left,
      top: source.top,
      width: source.width,
      height: source.height,
    }
    return {
      name: from.options.morph!,
      target,
      flow: new LiquidFlow(rect),
      volume: {
        ...rect,
        id: this.nextGhostId--,
        layer: target.volume.layer,
        options: from.options,
        fusion: from.options.fusion,
        clip: [...target.volume.clip],
        opacity: target.volume.opacity,
        brightness: target.volume.brightness,
        paintOrder: target.volume.paintOrder,
        press: 0,
        materialize: 1,
        host: target.volume.host,
      },
    }
  }

  private handover(name: string, surface: GlassSurface): { rect: Rect, partner: GlassSurface | null } | null {
    for (let i = 0; i < this.ghosts.length; i++) {
      const ghost = this.ghosts[i]!
      if (ghost.name !== name)
        continue
      this.ghosts.splice(i, 1)
      const volume = ghost.volume
      return {
        rect: {
          left: volume.left,
          top: volume.top,
          width: volume.width,
          height: volume.height,
        },
        partner: ghost.target,
      }
    }
    const departed = this.departed.get(name)
    this.departed.delete(name)
    if (departed && performance.now() - departed.time < HANDOVER_WINDOW)
      return { rect: departed.rect, partner: null }
    for (const other of this.surfaces) {
      if (other !== surface && other.options.morph === name && other.hasVolume && !other.handedOver) {
        other.handedOver = true
        return { rect: other.volume, partner: other }
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
          if (hasAttr(target, GLASS_ATTR)) {
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
        if (name === GLASS_PLACE_ATTR) {
          const owner = this.surfaceOwner(target)
          if (owner)
            owner.underDirty = true
          invalidated = true
          continue
        }
        if (name.startsWith('data-glass-')) {
          const surface = this.byElement.get(target) ?? this.surfaceOwner(target)
          if (surface)
            this.refresh(surface)
          this.refreshWithin(target)
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
          surface.underDirty = true
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

  private unregisterWithin(node: HTMLElement): void {
    if (node.isConnected)
      return
    for (const surface of [...this.surfaces]) {
      if (node.contains(surface.element))
        this.unregister(surface)
    }
  }

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
      surface.inherited = false
    }
    surface.dirty = true
    this.onInvalidate()
  }

  private refreshAll(): void {
    for (const surface of this.surfaces)
      this.refresh(surface)
  }

  private refreshWithin(element: HTMLElement): void {
    for (const surface of this.surfaces) {
      if (surface.element !== element && element.contains(surface.element))
        this.refresh(surface)
    }
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
