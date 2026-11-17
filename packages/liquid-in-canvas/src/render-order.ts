export const PAGE_RENDER_ORDER = 0

export const GLASS_LAYER_RANGE = [-100, 100] as const

export const OVERLAY_TOP_LAYER = GLASS_LAYER_RANGE[1] + 1

export function glassRenderOrder(layer: number): number {
  return 900 + layer * 10
}

export function glassVolumeRenderOrder(layer: number, paintOrder: number): number {
  return glassRenderOrder(layer) + paintOrder * 0.5
}

export function glassContentRenderOrder(layer: number, paintOrder: number): number {
  return glassRenderOrder(layer) + 1 + paintOrder
}

export function glassUnderRenderOrder(layer: number): number {
  return glassRenderOrder(layer) - 0.25
}

export function overlayRenderOrder(layer: number): number {
  return glassRenderOrder(layer) - 0.5
}
