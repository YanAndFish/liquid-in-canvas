import type { CanvasOverlay } from './CanvasOverlay.hot'
import type { ElementTexture, StageGpu } from './gpu'
import type { LiquidGlassLayer } from './liquid-glass/LiquidGlassLayer'
import { CLEAR_BLACK, HEADER_FLOATS } from './frame'
import { DrawList } from './frame.hot'
import { SLOT_CANVAS } from './gpu'
import { PAGE_RENDER_ORDER } from './render-order'

/**
 * 浏览器是否报告 `root` 的绘制记录在这次渲染更新里变了。
 *
 * 只有拿到 `paint` 事件的 `changedElements`、而且其中没有 `root` 时才返回 false；
 * 没有事件或浏览器不提供这个列表时一律当作变了。
 */
export function snapshotChanged(event: Event | undefined, root: Element): boolean {
  if (!event)
    return true
  const changed = (event as Partial<CanvasPaintEvent>).changedElements
  if (!changed)
    return true
  for (let i = 0; i < changed.length; i++) {
    if (changed[i] === root)
      return true
  }
  return false
}

/**
 * 舞台的一帧：页面快照 → 前景 → 玻璃（内容遮挡、模糊、体积）→ 画布遍。
 *
 * 所有绘制项的 uniform 写完后一次上传，离屏的几遍与画布遍编码进同一个命令缓冲。
 */
export class StageFrame {
  /** 前景层，舞台开始绘制后设置。 */
  overlay: CanvasOverlay | null = null
  /** 玻璃图层，舞台开始绘制后设置。 */
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

  /**
   * 画一帧。`shadingScale` 是玻璃体积着色相对画布的比例。
   * `upload` 为 false 时沿用快照纹理里上一帧的页面（见 `snapshotChanged()`）。
   */
  draw(root: HTMLElement, page: ElementTexture, shadingScale: number, event: Event | undefined, upload: boolean): void {
    const gpu = this.gpu
    const frame = gpu.frame
    const list = this.list
    frame.begin()
    list.reset()
    const { width, height } = this.canvas
    if (upload)
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
