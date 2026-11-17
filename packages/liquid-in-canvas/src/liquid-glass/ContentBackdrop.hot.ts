import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, SampledTexture, StageGpu } from '../gpu'
import type { ContentSource } from './content.hot'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { DrawList } from '../frame.hot'
import { RenderTarget, SLOT_TARGET } from '../gpu'
import { writeContent } from './content.hot'

export interface BackdropSource {
  readonly view: GPUTextureView
  readonly group: GPUBindGroup
}

export class ContentBackdrop {
  private readonly frame: FrameEncoder
  private readonly target: RenderTarget
  private readonly list = new DrawList()
  private readonly copy: PipelineTable
  private readonly occluded: PipelineTable

  constructor(gpu: StageGpu, occluded: PipelineTable) {
    this.frame = gpu.frame
    this.target = new RenderTarget(gpu)
    this.copy = gpu.blitOpaque
    this.occluded = occluded
  }

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
      const uniform = writeContent(frame, source, source.backdropOccluders, source.backdropOccluderCount, cssWidth, cssHeight, width, height)
      this.list.push(i, this.occluded.get(source.backdropOccluderCount), uniform, source.content.group)
    }
    return this.target
  }

  encode(encoder: GPUCommandEncoder): void {
    if (this.list.count > 0)
      this.frame.encodePass(encoder, 'backdrop', this.target.view, this.target.width, this.target.height, CLEAR_BLACK, this.list)
  }

  dispose(): void {
    this.list.reset()
    this.target.dispose()
  }
}
