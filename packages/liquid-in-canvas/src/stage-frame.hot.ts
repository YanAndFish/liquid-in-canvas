import type { CanvasOverlay } from './CanvasOverlay.hot'
import type { ElementTexture, StageGpu } from './gpu'
import type { LiquidGlassLayer } from './liquid-glass/LiquidGlassLayer'
import { CLEAR_BLACK, HEADER_FLOATS } from './frame'
import { DrawList } from './frame.hot'
import { SLOT_CANVAS } from './gpu'
import { PAGE_RENDER_ORDER } from './render-order'

export class StageFrame {
  overlay: CanvasOverlay | null = null
  glass: LiquidGlassLayer | null = null
  private readonly gpu: StageGpu
  private readonly context: GPUCanvasContext
  private readonly canvas: HTMLCanvasElement
  private readonly list = new DrawList()
  private readonly view: GPUTextureViewDescriptor

  constructor(gpu: StageGpu, context: GPUCanvasContext, canvas: HTMLCanvasElement) {
    this.gpu = gpu
    this.context = context
    this.canvas = canvas
    this.view = { format: gpu.canvasFormat }
  }

  draw(root: HTMLElement, page: ElementTexture, shadingScale: number, event: Event | undefined): void {
    const gpu = this.gpu
    const frame = gpu.frame
    const list = this.list
    frame.begin()
    list.reset()
    const { width, height } = this.canvas
    frame.upload(root, page.texture)
    list.push(PAGE_RENDER_ORDER, gpu.blitOpaque.get(SLOT_CANVAS), frame.full(HEADER_FLOATS, width, height) * 4, page.group)
    const overlay = this.overlay
    if (overlay)
      overlay.sync(list)
    const glass = this.glass
    let hasGlass = false
    if (glass) {
      glass.setShading(shadingScale, overlay ? overlay.renderOrder : Infinity)
      hasGlass = glass.sync(event, list)
    }
    const encoder = frame.beginEncoding()
    if (glass && hasGlass)
      glass.encode(encoder)
    frame.encodePass(encoder, 'canvas', this.context.getCurrentTexture().createView(this.view), width, height, CLEAR_BLACK, list)
    frame.submit(encoder)
  }
}
