import type { DrawList, FrameEncoder } from '../frame.hot'
import type { SampledTexture, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { ContentPipelines } from './content-shader'
import type { ContentSource } from './content.hot'
import type { FlowRect } from './flow.hot'
import type { VolumeSurface } from './fusion.hot'
import type { ElementBox, GlassGhost, GlassSurface, Rect, UnderContent } from './surface'
import type { VolumeGroupPlan, VolumeShading } from './VolumeGroups.hot'
import { attr, GLASS_CLIP_ATTR, GLASS_FADE_ATTR, GLASS_MODAL_ATTR } from '../contract'
import { glassContentRenderOrder, glassUnderRenderOrder } from '../render-order'
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

export interface GlassFrameHost {
  readonly surfaces: readonly GlassSurface[]
  readonly ghosts: GlassGhost[]
  readonly fading: GlassSurface[]
  readonly morphPending: boolean
  resolveMorphs: () => void
  release: (surface: GlassSurface) => void
  backdrop: () => SampledTexture | null
  prune: () => void
  refreshTextureSize: (surface: GlassSurface) => void
  kickPaint: (surface: GlassSurface) => void
  upload: (surface: GlassSurface) => boolean
  syncUnder: (surface: GlassSurface) => void
  refreshUnderSize: (item: UnderContent) => void
  uploadUnder: (item: UnderContent) => boolean
  invalidate: () => void
  startAnimation: () => void
  reducedMotion: () => boolean
  layoutSettling: () => boolean
}

const MODAL_SELECTOR = attr(GLASS_MODAL_ATTR)
const CLIP_SELECTOR = attr(GLASS_CLIP_ATTR)
const FADE_SELECTOR = attr(GLASS_FADE_ATTR)
const VISIBILITY: CheckVisibilityOptions = { visibilityProperty: true }
const UNBOUNDED = 100000
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

const GHOST_END = 2
const MORPH_FUSION = 32
const NECK_START = 0.5
const NECK_END = 0.92
const MATERIALIZE_STIFFNESS = 120
const MATERIALIZE_DAMPING = 12
const MATERIALIZE_GONE = 0.01
const REVEAL_BLUR = 6
const REVEAL_ZOOM = 0.2
const REVEAL_SWELL = 0.3
const REVEAL_SECONDS = 0.45
const GROW_RATIO = 1.2
const REVEAL_NONE = 0
const REVEAL_APPEAR = 1
const REVEAL_GROW = 2

function centerDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.left + a.width / 2 - b.left - b.width / 2, a.top + a.height / 2 - b.top - b.height / 2)
}

function morphFusion(a: number, b: number): number {
  return Math.max(a, b, MORPH_FUSION)
}

function neckFade(progress: number): number {
  const t = Math.min(1, Math.max(0, (progress - NECK_START) / (NECK_END - NECK_START)))
  return 1 - t * t * (3 - 2 * t)
}

function copyRect(target: FlowRect, source: Rect): void {
  target.left = source.left
  target.top = source.top
  target.width = source.width
  target.height = source.height
}

export class GlassFrame {
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly frame: FrameEncoder
  private readonly host: GlassFrameHost
  private readonly blurs: BackdropBlur[] = []
  private readonly volumes: VolumeGroups
  private readonly content: ContentPipelines
  private readonly backdrop: ContentBackdrop
  private readonly stack: StackBackdrops
  private readonly plans: (VolumeGroupPlan | null)[] = []
  private contentOrders = new Float64Array(32)
  private readonly order = new PaintOrder()
  private readonly boxes = new WeakMap<Element, ElementBox>()
  private readonly visible: GlassSurface[] = []
  private visibleCount = 0
  private readonly volumeList: VolumeSurface[] = []
  private volumeCount = 0
  private readonly occluded: ContentSource[] = []
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
    this.matrix = new DOMMatrix()
    this.geometry = { canvasTransform: this.matrix }
  }

  warm(volumeCounts: readonly number[], occluderCounts: readonly number[]): void {
    this.volumes.warm(volumeCounts)
    for (let i = 0; i < occluderCounts.length; i++)
      this.content.clear.warm(occluderCounts[i]!)
  }

  setOptics(optics: GlassOptics): void {
    this.volumes.setOptics(optics)
  }

  setFieldCache(enabled: boolean): void {
    this.volumes.setFieldCache(enabled)
  }

  setShading(scale: number, split: number): void {
    this.shading.scale = scale
    this.shading.split = split
  }

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
    if (host.morphPending)
      host.resolveMorphs()
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
    if (volumes.settling)
      host.invalidate()
    return true
  }

  encode(encoder: GPUCommandEncoder): void {
    this.backdrop.encode(encoder)
    this.blurs[0]!.encode(encoder)
    this.stack.encode(encoder)
    this.volumes.encode(encoder)
  }

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

  private advanceMaterialize(surface: GlassSurface, target: number, seconds: number, reduced: boolean): boolean {
    const spring = surface.materialize
    if (reduced || !surface.options.materialize) {
      spring.value = target
      spring.velocity = 0
      return false
    }
    return advanceSpring(spring, target, seconds, MATERIALIZE_STIFFNESS, MATERIALIZE_DAMPING)
  }

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
    const rect = surface.contentRect
    if (surface.revealGrowing && progress < 1) {
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
    let reveal = REVEAL_NONE
    if (shown !== surface.shown) {
      surface.shown = shown
      const animate = surface.options.materialize && !host.reducedMotion()
      if (shown) {
        const handover = surface.inherited || (surface.flow !== null && surface.flow.active)
        surface.inherited = false
        surface.hiding = false
        if (!handover && surface.everShown)
          surface.snapFlow = true
        surface.everShown = true
        surface.materialize.value = animate && !handover
          ? 0
          : 1
        surface.materialize.velocity = 0
        if (animate) {
          reveal = handover
            ? REVEAL_GROW
            : REVEAL_APPEAR
          host.startAnimation()
        }
      }
      else if (animate && surface.visible && surface.materialize.value > MATERIALIZE_GONE) {
        surface.hiding = true
        host.startAnimation()
      }
    }
    if (surface.hiding) {
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
      if (surface.underDirty)
        host.syncUnder(surface)
      const under = surface.under
      for (let u = 0; u < under.length; u++)
        this.measureUnder(surface, under[u]!, changed, visible)
    }
    surface.visible = visible
    surface.fullyVisible = fullyVisible

    const opacity = this.fade(element)
    const brightness = modal !== null && modal.contains(element)
      ? 1
      : dimming
    if (shown)
      this.flow(surface)
    else
      surface.hasTail = false
    if (reveal !== REVEAL_NONE)
      this.startReveal(surface, reveal === REVEAL_GROW)
    surface.hasVolume = visible
    if (visible) {
      const volume = surface.volume
      volume.layer = surface.host
        ? surface.host.options.layer
        : surface.options.layer
      volume.options = surface.options
      volume.fusion = surface.options.fusion
      this.linkPartner(surface)
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
      const flowing = surface.flow !== null && surface.flow.active
      const morphContent = surface.options.morphContent
      if (flowing && morphContent === 'follow')
        copyRect(surface.contentRect, volume)
      else
        copyRect(surface.contentRect, rect)
      if (flowing && morphContent === 'clip') {
        surface.contentClip[0] = Math.max(surface.contentClip[0]!, volume.left)
        surface.contentClip[1] = Math.max(surface.contentClip[1]!, volume.top)
        surface.contentClip[2] = Math.min(surface.contentClip[2]!, volume.left + volume.width)
        surface.contentClip[3] = Math.min(surface.contentClip[3]!, volume.top + volume.height)
      }
      else if (morphContent === 'static' && surface.flow !== null && surface.flow.resizing) {
        const reveal = surface.revealClip
        let left = volume.left
        let top = volume.top
        let right = volume.left + volume.width
        let bottom = volume.top + volume.height
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

  private linkPartner(surface: GlassSurface): void {
    const volume = surface.volume
    const partner = surface.partner
    volume.link = null
    volume.linkFusion = 0
    if (partner === null)
      return
    if (surface.flow === null || !surface.flow.active || !partner.hasVolume) {
      surface.partner = null
      return
    }
    volume.link = partner.volume
    volume.linkFusion = this.neck(surface, partner)
  }

  private neck(surface: GlassSurface, partner: GlassSurface): number {
    const flow = surface.flow
    const fusion = morphFusion(surface.options.fusion, partner.options.fusion)
    const fade = flow === null
      ? 0
      : neckFade(flow.progress())
    return Math.min(fusion * fade, rampedFusion(fusion, centerDistance(surface.volume, partner.volume)))
  }

  private updateGhosts(): void {
    const ghosts = this.host.ghosts
    let i = 0
    while (i < ghosts.length) {
      const ghost = ghosts[i]!
      const target = ghost.target
      const partner = ghost.partner
      const volume = ghost.volume
      const goal = target.volume
      const owner = partner === null
        ? goal
        : partner.volume
      let alive = target.hasVolume && target.element.isConnected && !this.host.reducedMotion()
        && (partner === null || (partner.hasVolume && partner.element.isConnected))
      if (alive) {
        const point = this.ghostPoint
        point.left = goal.left + goal.width / 2 - GHOST_END / 2
        point.top = goal.top + goal.height / 2 - GHOST_END / 2
        point.width = GHOST_END
        point.height = GHOST_END
        const options = (partner ?? target).options
        ghost.flow.configure(options.morphStretch, options.morphBounce, options.morphWobble, 0, options.morphSpeed)
        if (ghost.flow.retarget(point))
          this.host.startAnimation()
        ghost.flow.rect(volume)
        alive = ghost.flow.active && volume.width * volume.height > GHOST_END * GHOST_END * 2
      }
      if (!alive) {
        ghosts[i] = ghosts[ghosts.length - 1]!
        ghosts.pop()
        continue
      }
      volume.layer = owner.layer
      volume.host = owner.host
      volume.clip[0] = owner.clip[0]!
      volume.clip[1] = owner.clip[1]!
      volume.clip[2] = owner.clip[2]!
      volume.clip[3] = owner.clip[3]!
      volume.opacity = owner.opacity
      volume.brightness = owner.brightness
      volume.fusion = 0
      volume.moving = true
      volume.link = owner
      volume.linkFusion = partner === null
        ? rampedFusion(morphFusion(volume.options.fusion, target.options.fusion), centerDistance(volume, goal))
        : this.neck(partner, target)
      i++
    }
  }

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
      ghost.volume.paintOrder = (ghost.partner ?? ghost.target).volume.paintOrder
      this.volumeList[total++] = ghost.volume
    }
    this.volumeCount = total
  }

  private before(a: GlassSurface, b: GlassSurface): boolean {
    const layers = a.volume.layer - b.volume.layer
    if (layers !== 0)
      return layers < 0
    if (a.fading || b.fading)
      return !a.fading && b.fading
    return this.order.compare(a.element, b.element) < 0
  }

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
        if (other.host === surface.id || !covers(surface.contentRect, other))
          continue
        surface.occluders[surface.occluderCount++] = other
        const above = groups.planOf(other)
        if (plan === null || above === null || above.level <= plan.level || !stackSees(plan, above))
          surface.backdropOccluders[surface.backdropOccluderCount++] = other
      }
      const under = surface.under
      for (let u = 0; u < under.length; u++) {
        const item = under[u]!
        if (item.visible && item.content)
          occludedCount = this.planUnder(surface, item, plan, i, list, occludedCount, viewWidth, viewHeight)
      }
      const uniform = writeContent(this.frame, surface, surface.occluders, surface.occluderCount, viewWidth, viewHeight, canvasWidth, canvasHeight)
      list.push(order, clear.get(surface.occluderCount), uniform, content.group)
      if (surface.backdropOccluderCount > 0)
        this.occluded[occludedCount++] = surface
    }
    return occludedCount
  }

  private planUnder(
    surface: GlassSurface,
    item: UnderContent,
    plan: VolumeGroupPlan | null,
    index: number,
    list: DrawList,
    occludedCount: number,
    viewWidth: number,
    viewHeight: number,
  ): number {
    const visible = this.visible
    const clip = surface.contentClip
    item.contentClip[0] = clip[0]!
    item.contentClip[1] = clip[1]!
    item.contentClip[2] = clip[2]!
    item.contentClip[3] = clip[3]!
    item.contentOpacity = surface.contentOpacity
    item.occluders[0] = surface.volume
    item.backdropOccluders[0] = surface.volume
    item.occluderCount = 1
    item.backdropOccluderCount = 1
    const groups = this.volumes.groups
    for (let j = index + 1; j < this.visibleCount; j++) {
      const other = visible[j]!.volume
      if (!covers(item.contentRect, other))
        continue
      item.occluders[item.occluderCount++] = other
      const above = groups.planOf(other)
      if (plan === null || above === null || above.level <= plan.level || !stackSees(plan, above))
        item.backdropOccluders[item.backdropOccluderCount++] = other
    }
    const uniform = writeContent(this.frame, item, item.occluders, item.occluderCount, viewWidth, viewHeight, this.canvas.width, this.canvas.height)
    list.push(glassUnderRenderOrder(surface.volume.layer), this.content.clear.get(item.occluderCount), uniform, item.content!.group)
    this.occluded[occludedCount] = item
    return occludedCount + 1
  }

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

  private shown(element: HTMLElement): boolean {
    return typeof element.checkVisibility === 'function'
      ? element.checkVisibility(VISIBILITY)
      : legacyShown(element)
  }

  private measureUnder(surface: GlassSurface, item: UnderContent, changed: readonly Element[], visible: boolean): void {
    const element = item.element
    item.visible = false
    if (!visible || !this.shown(element))
      return
    const rect = item.rect
    const width = element.offsetWidth
    const height = element.offsetHeight
    if (width < 1 || height < 1)
      return
    const glass = surface.element
    let x = 0
    let y = 0
    let current: HTMLElement | null = element
    while (current !== null && current !== glass) {
      const parent: Element | null = current.offsetParent
      x += current.offsetLeft
      y += current.offsetTop
      if (parent === glass) {
        x += glass.clientLeft - glass.scrollLeft
        y += glass.clientTop - glass.scrollTop
        break
      }
      if (!(parent instanceof HTMLElement) || !glass.contains(parent)) {
        x -= glass.offsetLeft
        y -= glass.offsetTop
        break
      }
      x += parent.clientLeft - parent.scrollLeft
      y += parent.clientTop - parent.scrollTop
      current = parent
    }
    if (Math.abs(width - rect.width) > GEOMETRY_EPSILON || Math.abs(height - rect.height) > GEOMETRY_EPSILON) {
      if (rect.width > 0)
        this.host.refreshUnderSize(item)
      item.dirty = true
    }
    rect.left = surface.rect.left + x
    rect.top = surface.rect.top + y
    rect.width = width
    rect.height = height
    copyRect(item.contentRect, rect)
    if (!item.placed
      || Math.abs(item.placedLeft - rect.left) >= GEOMETRY_EPSILON
      || Math.abs(item.placedTop - rect.top) >= GEOMETRY_EPSILON) {
      this.matrix.e = rect.left
      this.matrix.f = rect.top
      this.canvas.updateElementGeometry(element, this.geometry)
      item.placed = true
      item.placedLeft = rect.left
      item.placedTop = rect.top
    }
    for (let k = 0; k < changed.length; k++) {
      if (element.contains(changed[k]!)) {
        item.dirty = true
        break
      }
    }
    if (item.dirty)
      this.host.uploadUnder(item)
    item.visible = item.uploaded
  }

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

  private flow(surface: GlassSurface): void {
    const volume = surface.volume
    const flow = surface.flow
    surface.hasTail = false
    volume.moving = false
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
    const resting = !flow.active
    if (resting && ((surface.reveal < 1 && !surface.revealGrowing) || this.host.layoutSettling())) {
      flow.snap(surface.layout)
      copyRect(volume, surface.rect)
      return
    }
    const options = surface.options
    const radius = options.radius
    flow.configure(options.morphStretch, options.morphBounce, options.morphWobble, Math.max(radius[0], radius[1], radius[2], radius[3]), options.morphSpeed)
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
    volume.moving = true
    const body = this.body
    flow.rect(body)
    volume.left = surface.originX + body.left
    volume.top = surface.originY + body.top
    volume.width = body.width
    volume.height = body.height
    const tail = surface.tail
    const taper = tail.taper!
    if (flow.tail(body, taper)) {
      taper.startX += surface.originX
      taper.startY += surface.originY
      taper.endX += surface.originX
      taper.endY += surface.originY
      tail.left = surface.originX + body.left
      tail.top = surface.originY + body.top
      tail.width = body.width
      tail.height = body.height
      tail.fusion = 0
      tail.link = volume
      tail.linkFusion = flow.tailFusion(morphFusion(options.fusion, 0))
      tail.moving = true
      surface.hasTail = true
    }
  }
}
