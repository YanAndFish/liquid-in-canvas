import type { DrawItem, SampledTexture, StageGpu } from '../gpu'
import type { ContentPart } from './content-material'
import { blitPipeline, HEADER_FLOATS, RenderTarget, TARGET_FORMAT } from '../gpu'

/** 取得一块被遮挡内容在指定目标上的绘制项，见 `planGlassContent()`。 */
type ContentDraw = (part: ContentPart, format: GPUTextureFormat, order: number) => DrawItem

/**
 * 把被上层玻璃覆盖的 HTML 内容加入背景，供折射和高斯卷积取样。
 *
 * 页面快照先复制到一张 CSS 分辨率的离屏目标，再叠加被覆盖的内容。快照本身还要画到画布上，
 * 不能直接写进去：上层玻璃的抗锯齿边缘和淡入淡出期间，被覆盖的文字会从下面透出来。
 */
export class ContentBackdrop {
  private readonly gpu: StageGpu
  private readonly target: RenderTarget
  private items: DrawItem[] = []

  constructor(gpu: StageGpu) {
    this.gpu = gpu
    this.target = new RenderTarget(gpu)
  }

  /** 被遮挡内容所在目标的像素尺寸，内容的 uniform 需要按它写入。 */
  static targetSize(cssWidth: number, cssHeight: number): { width: number, height: number } {
    return {
      width: Math.max(1, Math.ceil(cssWidth)),
      height: Math.max(1, Math.ceil(cssHeight)),
    }
  }

  /**
   * 安排本帧的合成，返回玻璃应当取样的背景；没有重叠时直接返回页面快照。
   * `overlays` 按从下到上的顺序排列。
   */
  plan(page: SampledTexture, overlays: readonly ContentDraw[], cssWidth: number, cssHeight: number): { view: GPUTextureView, group: GPUBindGroup } {
    this.items = []
    if (overlays.length === 0)
      return page
    const size = ContentBackdrop.targetSize(cssWidth, cssHeight)
    this.target.resize(size.width, size.height)
    const start = this.gpu.allocUniform(HEADER_FLOATS, {
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
      targetWidth: size.width,
      targetHeight: size.height,
      cssWidth: 1,
      cssHeight: 1,
    })
    this.items.push({
      order: -1,
      pipeline: blitPipeline(this.gpu, 'opaque', TARGET_FORMAT),
      uniform: start * 4,
      textures: page.group,
    })
    overlays.forEach((draw, i) => this.items.push(draw('occluded', TARGET_FORMAT, i)))
    return this.target
  }

  /** 编码 `plan()` 安排的合成。 */
  encode(encoder: GPUCommandEncoder): void {
    if (this.items.length)
      this.gpu.encodePass(encoder, 'backdrop', this.target, { r: 0, g: 0, b: 0, a: 1 }, this.items)
  }

  /** 释放离屏背景，内容纹理由各表面管理。 */
  dispose(): void {
    this.items = []
    this.target.dispose()
  }
}
