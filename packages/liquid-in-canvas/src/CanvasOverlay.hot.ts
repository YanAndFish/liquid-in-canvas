import type { DrawList } from './frame.hot'
import type { ElementTexture, StageGpu } from './gpu'
import { STAGE_OVERLAY_ATTR } from './contract'
import { HEADER_FLOATS } from './frame'
import { createElementTexture, disposeElementTexture, SLOT_CANVAS } from './gpu'
import { GLASS_LAYER_RANGE, OVERLAY_TOP_LAYER, overlayRenderOrder } from './render-order'

export function parseOverlayLayer(raw: string | null): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value))
    return OVERLAY_TOP_LAYER
  return Math.min(OVERLAY_TOP_LAYER, Math.max(GLASS_LAYER_RANGE[0], value))
}

export class CanvasOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly element: HTMLElement
  private readonly gpu: StageGpu
  private target: ElementTexture | null = null

  constructor(canvas: HTMLCanvasElement, element: HTMLElement, gpu: StageGpu) {
    this.canvas = canvas
    this.element = element
    this.gpu = gpu
    element.setAttribute('drawable', '')
    canvas.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix(),
    })
  }

  get renderOrder(): number {
    return overlayRenderOrder(parseOverlayLayer(this.element.getAttribute(STAGE_OVERLAY_ATTR)))
  }

  sync(list: DrawList): void {
    if (this.element.childElementCount === 0)
      return
    const { width, height } = this.canvas
    let target = this.target
    if (!target || target.texture.width !== width || target.texture.height !== height) {
      disposeElementTexture(target)
      target = createElementTexture(this.gpu, width, height)
      this.target = target
    }
    const frame = this.gpu.frame
    frame.upload(this.element, target.texture)
    list.push(this.renderOrder, this.gpu.blitLayer.get(SLOT_CANVAS), frame.full(HEADER_FLOATS, width, height) * 4, target.group)
  }

  dispose(): void {
    this.canvas.clearElementGeometry(this.element)
    this.element.removeAttribute('drawable')
    disposeElementTexture(this.target)
    this.target = null
  }
}
