export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface ProductFlight {
  image: string
  from: RectLike
  radius: number
}

export interface BagFlight {
  image: string
  from: RectLike
}

export interface SharedLayer {
  startProductFlight: (flight: ProductFlight) => void
  completeProductFlight: (target: () => RectLike | null, toRadius: number, onDone: () => void) => boolean
  flyToBag: (flight: BagFlight, to: RectLike | null) => void
}

let sharedLayer: SharedLayer | null = null

export function registerSharedLayer(layer: SharedLayer | null): void {
  sharedLayer = layer
}

export function getSharedLayer(): SharedLayer | null {
  return sharedLayer
}

export function bagTargetRect(): RectLike | null {
  if (typeof document === 'undefined')
    return null
  const target = document.querySelector<HTMLElement>('[data-bag-target]')
  return target
    ? target.getBoundingClientRect()
    : null
}
