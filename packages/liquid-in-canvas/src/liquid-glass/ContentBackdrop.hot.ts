import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, SampledTexture, StageGpu } from '../gpu'
import type { ContentSource } from './content.hot'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { DrawList } from '../frame.hot'
import { RenderTarget, SLOT_TARGET } from '../gpu'
import { writeContent } from './content.hot'

/** 玻璃取样的背景：一张纹理视图，以及只取样它的绑定。 */
export interface BackdropSource {
  readonly view: GPUTextureView
  readonly group: GPUBindGroup
}

/**
 * 把被上层玻璃覆盖的 HTML 内容加入背景，供折射和高斯卷积取样。
 *
 * 页面快照先复制到一张 CSS 分辨率的离屏目标，再叠加被覆盖的内容。快照本身还要画到画布上，
 * 不能直接写进去：上层玻璃的抗锯齿边缘和淡入淡出期间，被覆盖的文字会从下面透出来。
 */
export class ContentBackdrop {
  private readonly frame: FrameEncoder
  private readonly target: RenderTarget
  private readonly list = new DrawList()
  private readonly copy: PipelineTable
  private readonly occluded: PipelineTable

  /** `occluded` 是被覆盖内容的管线表，按遮挡数量取用，见 `createContentPipelines()`。 */
  constructor(gpu: StageGpu, occluded: PipelineTable) {
    this.frame = gpu.frame
    this.target = new RenderTarget(gpu)
    this.copy = gpu.blitOpaque
    this.occluded = occluded
  }

  /**
   * 安排本帧的合成，返回玻璃应当取样的背景；没有重叠时直接返回页面快照。
   * `sources` 的前 `count` 项按从下到上的顺序排列，每一项至少被一块上层玻璃覆盖。
   */
  plan(page: SampledTexture, sources: readonly ContentSource[], count: number, cssWidth: number, cssHeight: number): BackdropSource {
    this.list.reset()
    if (count === 0)
      return page
    const width = Math.max(1, Math.ceil(cssWidth))
    const height = Math.max(1, Math.ceil(cssHeight))
    this.target.resize(width, height)
    const frame = this.frame
    this.list.push(-1, this.copy.get(SLOT_TARGET), frame.full(HEADER_FLOATS, width, height) * 4, page.group)
    for (let i = 0; i < count; i++) {
      const source = sources[i]!
      if (!source.content)
        continue
      const uniform = writeContent(frame, source, cssWidth, cssHeight, width, height)
      this.list.push(i, this.occluded.get(source.occluderCount), uniform, source.content.group)
    }
    return this.target
  }

  /** 编码 `plan()` 安排的合成。 */
  encode(encoder: GPUCommandEncoder): void {
    if (this.list.count > 0)
      this.frame.encodePass(encoder, 'backdrop', this.target.view, this.target.width, this.target.height, CLEAR_BLACK, this.list)
  }

  /** 释放离屏背景，内容纹理由各表面管理。 */
  dispose(): void {
    this.list.reset()
    this.target.dispose()
  }
}
