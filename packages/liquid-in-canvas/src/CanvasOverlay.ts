import type { DrawItem, ElementTexture, StageGpu } from './gpu'
import { STAGE_OVERLAY_ATTR } from './contract'
import { blitPipeline, createElementTexture, disposeElementTexture, HEADER_FLOATS, uploadElement } from './gpu'
import { GLASS_LAYER_RANGE, OVERLAY_TOP_LAYER, overlayRenderOrder } from './render-order'

/** 读取前景层声明的层级；没有声明或无法解析时位于所有玻璃之上。 */
export function parseOverlayLayer(raw: string | null): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value))
    return OVERLAY_TOP_LAYER
  return Math.min(OVERLAY_TOP_LAYER, Math.max(GLASS_LAYER_RANGE[0], value))
}

/**
 * 透明前景层：整层单独上传，按声明的层级插在玻璃之间。
 *
 * 页面快照总在所有玻璃之下。需要盖住一部分玻璃、又被另一部分玻璃盖住的内容
 * （例如跨越多块玻璃的过渡动画）放进前景层。
 */
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

  /** 前景层当前的绘制顺序。 */
  get renderOrder(): number {
    return overlayRenderOrder(parseOverlayLayer(this.element.getAttribute(STAGE_OVERLAY_ATTR)))
  }

  /** 上传前景层并返回它在画布遍中的绘制项；前景层为空时不上传也不绘制。 */
  sync(): DrawItem | null {
    if (this.element.childElementCount === 0)
      return null
    const { width, height } = this.canvas
    if (!this.target || this.target.texture.width !== width || this.target.texture.height !== height) {
      disposeElementTexture(this.target)
      this.target = createElementTexture(this.gpu, width, height)
    }
    uploadElement(this.gpu.device, this.element, this.target.texture)
    const start = this.gpu.allocUniform(HEADER_FLOATS, {
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
      targetWidth: width,
      targetHeight: height,
      cssWidth: 1,
      cssHeight: 1,
    })
    return {
      order: this.renderOrder,
      pipeline: blitPipeline(this.gpu, 'layer', this.gpu.canvasFormat),
      uniform: start * 4,
      textures: this.target.group,
    }
  }

  /** 释放前景纹理。 */
  dispose(): void {
    this.canvas.clearElementGeometry(this.element)
    this.element.removeAttribute('drawable')
    disposeElementTexture(this.target)
    this.target = null
  }
}
