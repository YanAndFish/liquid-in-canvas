import type { ElementTexture } from '../gpu'
import type { SpringState } from '../shared/spring.hot'
import type { ContentSource } from './content.hot'
import type { LiquidFlow } from './flow.hot'
import type { VolumeSurface } from './fusion.hot'
import type { GlassOptions } from './options'
import { attr, GLASS_SCRIM_ATTR } from '../contract'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface UnderContent extends ContentSource {
  readonly element: HTMLElement
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  addedDrawable: boolean
  placed: boolean
  placedLeft: number
  placedTop: number
  dirty: boolean
  uploaded: boolean
  visible: boolean
}

export function createUnderContent(element: HTMLElement, content: ElementTexture | null, width: number, height: number, addedDrawable: boolean): UnderContent {
  return {
    element,
    content,
    textureWidth: width,
    textureHeight: height,
    addedDrawable,
    placed: false,
    placedLeft: 0,
    placedTop: 0,
    dirty: true,
    uploaded: false,
    visible: false,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    contentRect: { left: 0, top: 0, width: 0, height: 0 },
    padding: 0,
    contentClip: [0, 0, 0, 0],
    contentOpacity: 1,
    contentScale: 1,
    contentBlur: 0,
    contentOriginX: 0,
    contentOriginY: 0,
    occluders: [],
    occluderCount: 0,
    backdropOccluders: [],
    backdropOccluderCount: 0,
  }
}

export interface GlassSurface extends ContentSource {
  readonly id: number
  readonly element: HTMLElement
  readonly host: GlassSurface | null
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string

  flow: LiquidFlow | null
  snapFlow: boolean
  handedOver: boolean
  inherited: boolean
  partner: GlassSurface | null

  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  sizeDirty: boolean

  placed: boolean
  placedLeft: number
  placedTop: number
  placedWidth: number
  placedHeight: number

  dirty: boolean
  settleFrames: number
  paintPending: boolean
  contentComplete: boolean
  visible: boolean
  fullyVisible: boolean
  addedDrawable: boolean
  resizeObserver: ResizeObserver | null
  retryTimer: number | null
  onScroll: () => void
  onTransitionEnd: () => void
  readonly press: SpringState
  readonly materialize: SpringState
  shown: boolean
  everShown: boolean
  hiding: boolean
  fading: boolean
  reveal: number
  readonly revealClip: number[]
  revealGrowing: boolean
  revealX: number
  revealY: number

  readonly rect: Rect
  readonly layout: Rect
  originX: number
  originY: number
  readonly volume: VolumeSurface
  hasVolume: boolean
  readonly tail: VolumeSurface
  hasTail: boolean
  readonly under: UnderContent[]
  underDirty: boolean
}

export interface GlassGhost {
  readonly name: string
  readonly target: GlassSurface
  readonly flow: LiquidFlow
  readonly volume: VolumeSurface
}

export interface SurfaceInit {
  id: number
  element: HTMLElement
  host: GlassSurface | null
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  addedDrawable: boolean
}

export function createSurface(init: SurfaceInit): GlassSurface {
  const surface: GlassSurface = {
    ...init,
    flow: null,
    snapFlow: true,
    handedOver: false,
    inherited: false,
    partner: null,
    sizeDirty: false,
    placed: false,
    placedLeft: 0,
    placedTop: 0,
    placedWidth: 0,
    placedHeight: 0,
    dirty: true,
    settleFrames: 4,
    paintPending: false,
    contentComplete: false,
    visible: false,
    fullyVisible: false,
    resizeObserver: null,
    retryTimer: null,
    onScroll: () => {},
    onTransitionEnd: () => {},
    press: { value: 0, velocity: 0 },
    materialize: {
      value: init.options.materialize ? 0 : 1,
      velocity: 0,
    },
    shown: false,
    everShown: false,
    hiding: false,
    fading: false,
    reveal: 1,
    revealClip: [0, 0, 0, 0],
    revealGrowing: false,
    revealX: 0,
    revealY: 0,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    contentRect: { left: 0, top: 0, width: 0, height: 0 },
    layout: { left: 0, top: 0, width: 0, height: 0 },
    originX: 0,
    originY: 0,
    volume: {
      id: init.id,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      layer: init.options.layer,
      options: init.options,
      fusion: init.options.fusion,
      clip: [0, 0, 0, 0],
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      materialize: 1,
      host: init.host?.id ?? null,
    },
    hasVolume: false,
    tail: {
      id: -init.id - 1,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      layer: init.options.layer,
      options: init.options,
      fusion: 0,
      clip: [0, 0, 0, 0],
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      materialize: 1,
      host: init.host?.id ?? null,
    },
    hasTail: false,
    under: [],
    underDirty: true,
    padding: 0,
    contentClip: [0, 0, 0, 0],
    contentOpacity: 1,
    contentScale: 1,
    contentBlur: 0,
    contentOriginX: 0,
    contentOriginY: 0,
    occluders: [],
    occluderCount: 0,
    backdropOccluders: [],
    backdropOccluderCount: 0,
  }
  surface.tail.depthFrom = surface.volume
  return surface
}

export interface ElementBox {
  frame: number
  left: number
  top: number
  right: number
  bottom: number
  opacityFrame: number
  opacity: number
}

export function createElementBox(): ElementBox {
  return {
    frame: -1,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    opacityFrame: -1,
    opacity: 1,
  }
}

export function legacyShown(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
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

const SCRIM_SELECTOR = attr(GLASS_SCRIM_ATTR)

export function modalFactor(modal: HTMLElement): number {
  const scrim = modal.querySelector<HTMLElement>(SCRIM_SELECTOR)
  if (!scrim)
    return 1
  const shellOpacity = Number.parseFloat(getComputedStyle(modal).opacity)
  const opacity = Number.isFinite(shellOpacity)
    ? shellOpacity
    : 1
  return 1 - colorAlpha(getComputedStyle(scrim).backgroundColor) * opacity
}
