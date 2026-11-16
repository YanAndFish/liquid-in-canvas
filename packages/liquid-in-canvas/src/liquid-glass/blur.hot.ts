import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, StageGpu } from '../gpu'
import type { BlurLevel, BlurPass } from './blur-shader'
import type { CoverRect } from './cover.hot'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { blurViews, createBlurLevels, createBlurPasses, createBlurPipeline } from './blur-shader'
import { BLUR_SIGMAS, incrementalSigma } from './gaussian'

const KERNEL_REACH = 3

export function blurReach(maxVariance: number): number {
  let reach = 0
  let previous = 0
  for (let i = 0; i < BLUR_SIGMAS.length; i++) {
    if (previous * previous >= maxVariance)
      break
    const sigma = BLUR_SIGMAS[i]!
    reach += incrementalSigma(previous, sigma) * KERNEL_REACH
    previous = sigma
  }
  return reach
}

export class BackdropBlur {
  generation = 0
  readonly views: GPUTextureView[]
  private readonly frame: FrameEncoder
  private readonly pipeline: PipelineTable
  private readonly levels: BlurLevel[]
  private readonly passes: BlurPass[]
  private passCount = 0
  private disposed = false

  constructor(gpu: StageGpu) {
    this.frame = gpu.frame
    this.pipeline = createBlurPipeline(gpu)
    this.levels = createBlurLevels(gpu)
    this.passes = createBlurPasses(this.levels)
    this.views = blurViews(this.levels)
  }

  plan(source: GPUBindGroup, width: number, height: number, maxVariance: number, region: CoverRect | null = null): void {
    this.passCount = 0
    if (this.disposed || width < 1 || height < 1)
      return
    const pipeline = this.pipeline.get(0)
    let input = source
    let previousSigma = 0
    let remaining = region
      ? blurReach(maxVariance)
      : 0
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i]!
      if (previousSigma * previousSigma >= maxVariance)
        break
      const downsample = Math.min(level.sigma, 16)
      const targetWidth = Math.max(1, Math.ceil(width / downsample))
      const targetHeight = Math.max(1, Math.ceil(height / downsample))
      const resized = level.horizontal.resize(targetWidth, targetHeight)
      if (level.vertical.resize(targetWidth, targetHeight) || resized) {
        this.generation++
        this.views[i] = level.vertical.view
      }
      const sigma = incrementalSigma(previousSigma, level.sigma)
      const kernel = sigma * KERNEL_REACH
      remaining = Math.max(0, remaining - kernel)
      this.pass(pipeline, input, sigma / width, 0, region, remaining, remaining + kernel, width, height)
      this.pass(pipeline, level.horizontal.group, 0, sigma / height, region, remaining, remaining, width, height)
      input = level.vertical.group
      previousSigma = level.sigma
    }
  }

  encode(encoder: GPUCommandEncoder): void {
    for (let i = 0; i < this.passCount; i++) {
      const pass = this.passes[i]!
      const target = pass.target
      this.frame.encodePass(encoder, 'blur', target.view, target.width, target.height, CLEAR_BLACK, pass.list)
    }
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.passCount = 0
    for (const level of this.levels) {
      level.horizontal.dispose()
      level.vertical.dispose()
    }
  }

  private pass(
    pipeline: GPURenderPipeline,
    source: GPUBindGroup,
    x: number,
    y: number,
    region: CoverRect | null,
    padX: number,
    padY: number,
    width: number,
    height: number,
  ): void {
    const pass = this.passes[this.passCount++]!
    const target = pass.target
    const start = region
      ? this.frame.rect(
          HEADER_FLOATS + 4,
          Math.max(0, region.left - padX),
          Math.max(0, region.top - padY),
          Math.min(width, region.right + padX),
          Math.min(height, region.bottom + padY),
          width,
          height,
          target.width,
          target.height,
        )
      : this.frame.full(HEADER_FLOATS + 4, target.width, target.height)
    const data = this.frame.data
    data[start + 8] = x
    data[start + 9] = y
    pass.list.reset()
    pass.list.push(0, pipeline, start * 4, source)
  }
}
