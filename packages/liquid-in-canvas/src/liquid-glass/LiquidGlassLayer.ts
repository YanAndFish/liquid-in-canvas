import type { DrawList } from '../frame.hot'
import type { ElementTexture, SampledTexture, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { GlassTheme } from './defaults'
import type { GlassFrameHost } from './glass-frame.hot'
import type { GlassOptions } from './options'
import type { GlassGhost, GlassSurface, OutgoingContent, Rect, UnderContent } from './surface'
import { attr, GLASS_ATTR, GLASS_PLACE_ATTR, hasAttr } from '../contract'
import { createElementTexture, disposeElementTexture } from '../gpu'
import { reducedMotionQuery } from '../shared/motion'
import { onGlassDefaultsChange } from './defaults'
import { LiquidFlow } from './flow.hot'
import { GlassFrame } from './glass-frame.hot'
import { glassOptionsSignature, glassScopes, parseGlassOptions } from './options'
import { createOutgoingContent, createSurface, createUnderContent } from './surface'
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

interface Departed {
  name: string
  scopes: readonly HTMLElement[]
  rect: Rect
  time: number
  ghost: GlassGhost | null
  fading: GlassSurface | null
}

interface Leaving {
  surface: GlassSurface
  consumed: boolean
}

const HANDOVER_WINDOW = 400
const OUTGOING_SECONDS = 0.24
const MORPH_RESIZE_RATIO = 1.2
const EMIT_SCALE = 0.6
const EMIT_DEPTH = 0.2
const RESOURCE_SETTLE = 300
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

function copyRect(rect: Rect): Rect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function layerOf(surface: GlassSurface): number {
  return surface.host ? surface.host.options.layer : surface.options.layer
}

function emission(source: Rect, target: Rect): Rect {
  const centerX = target.left + target.width / 2
  const centerY = target.top + target.height / 2
  const right = source.left + source.width
  const bottom = source.top + source.height
  const outX = centerX < source.left
    ? centerX - source.left
    : Math.max(centerX - right, 0)
  const outY = centerY < source.top
    ? centerY - source.top
    : Math.max(centerY - bottom, 0)
  const sideways = Math.abs(outX) >= Math.abs(outY)
  const width = Math.max(1, Math.min(target.width, source.width) * (outX !== 0 && sideways
    ? EMIT_DEPTH
    : EMIT_SCALE))
  const height = Math.max(1, Math.min(target.height, source.height) * (outY !== 0 && !sideways
    ? EMIT_DEPTH
    : EMIT_SCALE))
  const x = Math.min(Math.max(centerX, source.left + width / 2), right - width / 2)
  const y = Math.min(Math.max(centerY, source.top + height / 2), bottom - height / 2)
  return {
    left: x - width / 2,
    top: y - height / 2,
    width,
    height,
  }
}

function pickByScope<T>(
  items: readonly T[],
  scopesOf: (item: T) => readonly HTMLElement[],
  scopes: readonly HTMLElement[],
  elementOf?: (item: T) => HTMLElement,
): T | null {
  for (let level = 0; level <= scopes.length; level++) {
    const scope = scopes[level] ?? null
    let best: T | null = null
    for (const item of items) {
      if (scope !== null && !scopesOf(item).includes(scope))
        continue
      if (best === null || (elementOf && elementOf(best).compareDocumentPosition(elementOf(item)) & Node.DOCUMENT_POSITION_PRECEDING))
        best = item
    }
    if (best !== null)
      return best
  }
  return null
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
  private departed: Departed[] = []
  private readonly entering: GlassSurface[] = []
  private readonly leaving: Leaving[] = []
  private quiet = false
  private resourceTime = -Infinity
  private mutationTime = -Infinity
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
    this.root.addEventListener('load', this.handleResource, { capture: true, passive: true })
    document.fonts?.addEventListener('loadingdone', this.handleResource)
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
    this.root.removeEventListener('load', this.handleResource, { capture: true })
    document.fonts?.removeEventListener('loadingdone', this.handleResource)
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
    this.departed = []
    this.entering.length = 0
    this.leaving.length = 0
    for (const ghost of this.ghosts)
      this.dropOutgoing(ghost)
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

  readonly invalidate = (): void => {
    this.onInvalidate()
  }

  release(surface: GlassSurface): void {
    const index = this.fading.indexOf(surface)
    if (index >= 0)
      this.fading.splice(index, 1)
    this.dropOutgoing(surface)
    disposeElementTexture(surface.content)
    surface.content = null
  }

  releaseOutgoing(outgoing: OutgoingContent): void {
    disposeElementTexture(outgoing.content)
    outgoing.content = null
    outgoing.active = false
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
    this.quiet = true
    try {
      for (const element of this.root.querySelectorAll<HTMLElement>(GLASS_SELECTOR))
        this.register(element)
    }
    finally {
      this.quiet = false
    }
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
      scopes: glassScopes(element),
      content,
      textureWidth: size.width,
      textureHeight: size.height,
      addedDrawable,
    })
    Object.assign(surface.layout, initial.layout)
    Object.assign(surface.rect, initial.rect)
    surface.originX = initial.originX
    surface.originY = initial.originY
    if (options.morph !== null) {
      surface.flow = new LiquidFlow(surface.layout)
      if (!this.quiet && !this.reducedMotion()) {
        surface.pending = true
        this.entering.push(surface)
      }
    }

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
      if (this.ghosts[i]!.target === surface || this.ghosts[i]!.partner === surface) {
        this.dropOutgoing(this.ghosts[i]!)
        this.ghosts.splice(i, 1)
      }
    }
    if (surface.pending) {
      surface.pending = false
      this.entering.splice(this.entering.indexOf(surface), 1)
    }
    surface.partner = null
    surface.volume.link = null
    const morphing = surface.options.morph !== null
      && surface.hasVolume
      && !this.disposed
      && !this.reducedMotion()
    if (morphing)
      this.leaving.push({ surface, consumed: false })
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
    if (morphing)
      this.startAnimation()
    else if (this.fades(surface))
      this.beginFade(surface)
    else
      this.dropContent(surface)
    this.onInvalidate()
  }

  layoutSettling(): boolean {
    const now = performance.now()
    return now - this.resourceTime < RESOURCE_SETTLE && this.mutationTime < this.resourceTime
  }

  private readonly handleResource = (): void => {
    this.resourceTime = performance.now()
    for (const surface of this.surfaces)
      surface.dirty = true
    this.onInvalidate()
  }

  get morphPending(): boolean {
    return this.entering.length > 0 || this.leaving.length > 0
  }

  resolveMorphs(): void {
    const now = performance.now()
    this.departed = this.departed.filter(entry => now - entry.time < HANDOVER_WINDOW)
    const entering = this.entering.splice(0)
    for (const surface of entering)
      this.resolveEnter(surface, now)
    const leaving = this.leaving.splice(0)
    for (const entry of leaving) {
      if (!entry.consumed)
        this.resolveLeave(entry.surface, now)
    }
  }

  private fades(surface: GlassSurface): boolean {
    return surface.host === null
      && surface.options.materialize
      && surface.visible
      && surface.content !== null
      && !this.disposed
      && !this.reducedMotion()
  }

  private beginFade(surface: GlassSurface): void {
    surface.fading = true
    surface.hiding = false
    surface.hasTail = false
    surface.volume.link = null
    this.fading.push(surface)
    this.startAnimation()
  }

  private dropOutgoing(owner: { outgoing: OutgoingContent | null }): void {
    if (owner.outgoing) {
      this.releaseOutgoing(owner.outgoing)
      owner.outgoing = null
    }
  }

  private takeTexture(surface: GlassSurface): ElementTexture | null {
    const content = surface.content
    surface.content = null
    return content
  }

  private dropContent(surface: GlassSurface): void {
    this.dropOutgoing(surface)
    disposeElementTexture(surface.content)
    surface.content = null
  }

  private resolveEnter(surface: GlassSurface, now: number): void {
    if (!surface.pending)
      return
    surface.pending = false
    if (this.byElement.get(surface.element) !== surface || !this.shownNow(surface.element))
      return
    const name = surface.options.morph
    const inherited = name
      ? this.takeDeparted(name, surface, now)
      : null
    if (inherited) {
      this.startFlow(surface, inherited.rect, null)
      if (inherited.content && !surface.host) {
        this.dropOutgoing(surface)
        surface.outgoing = createOutgoingContent(inherited.content, inherited.rect, surface.volume, OUTGOING_SECONDS)
      }
      return
    }
    for (const from of surface.options.morphFrom) {
      const source = this.findPresent(from, surface)
      if (!source)
        continue
      if (source.pending)
        this.resolveEnter(source, now)
      const start = emission(this.currentVolume(source), surface.rect)
      this.startFlow(surface, start, source)
      if (layerOf(source) !== layerOf(surface) || source.host !== surface.host)
        this.ghosts.push(this.createGhost(source.options, start, source, surface))
      return
    }
  }

  private startFlow(surface: GlassSurface, rect: Rect, partner: GlassSurface | null): void {
    surface.flow = new LiquidFlow({
      left: rect.left - surface.originX,
      top: rect.top - surface.originY,
      width: rect.width,
      height: rect.height,
    })
    surface.partner = partner
    surface.snapFlow = false
    surface.inherited = true
    this.startAnimation()
  }

  private resolveLeave(surface: GlassSurface, now: number): void {
    const name = surface.options.morph
    let target: GlassSurface | null = null
    for (const to of surface.options.morphTo) {
      target = this.findPresent(to, surface)
      if (target)
        break
    }
    const rect = copyRect(surface.volume)
    let ghost: GlassGhost | null = null
    let fading: GlassSurface | null = null
    if (target) {
      this.dropOutgoing(surface)
      const texture = surface.host === null
        ? this.takeTexture(surface)
        : null
      if (texture === null)
        this.dropContent(surface)
      ghost = this.createGhost(surface.options, rect, target, null)
      if (texture !== null)
        ghost.outgoing = createOutgoingContent(texture, rect, ghost.volume, OUTGOING_SECONDS)
      this.ghosts.push(ghost)
      this.startAnimation()
    }
    else if (this.fades(surface)) {
      fading = surface
      this.beginFade(surface)
    }
    else {
      this.dropContent(surface)
    }
    if (name) {
      this.departed.push({
        name,
        scopes: surface.scopes,
        rect,
        time: now,
        ghost,
        fading,
      })
    }
  }

  private takeDeparted(name: string, surface: GlassSurface, now: number): { rect: Rect, content: ElementTexture | null } | null {
    const leaving = this.leaving.filter(entry => !entry.consumed && entry.surface.options.morph === name)
    const chosen = pickByScope(leaving, entry => entry.surface.scopes, surface.scopes)
    if (chosen) {
      chosen.consumed = true
      this.dropOutgoing(chosen.surface)
      const content = surface.host === null
        ? this.takeTexture(chosen.surface)
        : null
      if (content === null)
        this.dropContent(chosen.surface)
      return {
        rect: copyRect(chosen.surface.volume),
        content,
      }
    }
    const departed = pickByScope(
      this.departed.filter(entry => entry.name === name && now - entry.time < HANDOVER_WINDOW),
      entry => entry.scopes,
      surface.scopes,
    )
    if (!departed)
      return null
    this.departed.splice(this.departed.indexOf(departed), 1)
    const ghost = departed.ghost
    if (ghost) {
      const index = this.ghosts.indexOf(ghost)
      if (index >= 0) {
        this.ghosts.splice(index, 1)
        let content: ElementTexture | null = null
        if (ghost.outgoing) {
          if (surface.host === null && ghost.outgoing.active && ghost.outgoing.content) {
            content = ghost.outgoing.content
            ghost.outgoing.content = null
            ghost.outgoing.active = false
          }
          else {
            this.dropOutgoing(ghost)
          }
        }
        return {
          rect: copyRect(ghost.volume),
          content,
        }
      }
    }
    const fading = departed.fading
    if (fading && this.fading.includes(fading)) {
      const rect = copyRect(fading.volume)
      const content = surface.host === null
        ? this.takeTexture(fading)
        : null
      this.release(fading)
      return { rect, content }
    }
    return {
      rect: departed.rect,
      content: null,
    }
  }

  private findPresent(name: string, requester: GlassSurface): GlassSurface | null {
    const candidates = this.surfaces.filter(other => other !== requester
      && other.options.morph === name
      && (other.pending || other.hasVolume || this.shownNow(other.element)))
    return pickByScope(candidates, other => other.scopes, requester.scopes, other => other.element)
  }

  private shownNow(element: HTMLElement): boolean {
    return element.isConnected
      && (typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true }))
  }

  private currentVolume(surface: GlassSurface): Rect {
    if (surface.hasVolume && !surface.pending)
      return copyRect(surface.volume)
    if (surface.flow && !surface.snapFlow) {
      const body = { left: 0, top: 0, width: 0, height: 0 }
      surface.flow.rect(body)
      return {
        left: body.left + surface.originX,
        top: body.top + surface.originY,
        width: body.width,
        height: body.height,
      }
    }
    return copyRect(surface.rect)
  }

  private createGhost(options: GlassOptions, rect: Rect, target: GlassSurface, partner: GlassSurface | null): GlassGhost {
    const owner = partner ?? target
    return {
      target,
      partner,
      flow: new LiquidFlow(rect),
      volume: {
        ...rect,
        id: this.nextGhostId--,
        layer: owner.volume.layer,
        options,
        fusion: 0,
        clip: [...owner.volume.clip],
        opacity: owner.volume.opacity,
        brightness: owner.volume.brightness,
        paintOrder: owner.volume.paintOrder,
        press: 0,
        materialize: 1,
        host: owner.volume.host,
        link: null,
        linkFusion: 0,
      },
      outgoing: null,
    }
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
      if (record.type !== 'attributes' || record.attributeName !== 'style' || !this.byElement.has(record.target as HTMLElement))
        this.mutationTime = performance.now()
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
    surface.scopes = glassScopes(surface.element)
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
    const previous = surface.content
    const preserve = previous !== null
      && surface.flow !== null
      && surface.options.materialize
      && !this.reducedMotion()
      && surface.visible
      && surface.placed
      && !surface.snapFlow
      && !this.layoutSettling()
      && surface.volume.width > 0
      && surface.volume.height > 0
      && Math.max(
        surface.rect.width / Math.max(surface.volume.width, 1),
        surface.volume.width / Math.max(surface.rect.width, 1),
        surface.rect.height / Math.max(surface.volume.height, 1),
        surface.volume.height / Math.max(surface.rect.height, 1),
      ) >= MORPH_RESIZE_RATIO
    if (preserve) {
      this.dropOutgoing(surface)
      surface.outgoing = createOutgoingContent(previous, surface.volume, surface.volume, OUTGOING_SECONDS)
      this.startAnimation()
    }
    else {
      disposeElementTexture(previous)
    }
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
