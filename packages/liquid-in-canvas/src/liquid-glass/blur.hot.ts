import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, StageGpu } from '../gpu'
import type { BlurLevel, BlurPass } from './blur-shader'
import type { CoverRect } from './cover.hot'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { blurViews, createBlurLevels, createBlurPasses, createBlurPipeline } from './blur-shader'
import { BLUR_SIGMAS, incrementalSigma } from './gaussian'

/** 卷积核覆盖的标准差倍数，与 `gaussianKernel()` 一致。 */
const KERNEL_REACH = 3

/**
 * 只卷积一部分区域时，背景需要在区域之外画好的宽度：
 * 每一级都要读取上一级在核半径之内的结果，各级的核半径依次累加。
 */
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

/** 逐级卷积页面背景，生成与设备像素密度无关的高斯模糊纹理。 */
export class BackdropBlur {
  /** 任意一层的纹理被重新创建时加一，取样这些纹理的绑定需要随之重建。 */
  generation = 0
  /** 按标准差从小到大排列的模糊纹理，纹理重新创建时就地更新。 */
  readonly views: GPUTextureView[]
  private readonly frame: FrameEncoder
  private readonly pipeline: PipelineTable
  private readonly levels: BlurLevel[]
  /** 每层横向、纵向各一遍，按执行顺序排列。 */
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

  /**
   * 使用 CSS 视口尺寸计算采样间距，安排本帧要生成的各级模糊。
   *
   * `source` 是只取样背景的绑定。`maxVariance` 是本帧玻璃会取样的最大方差；
   * 上一层已经覆盖它时，后面的层不再生成。`region` 不为空时只保证这个范围（CSS 像素）内的结果正确，
   * 每一级只卷积它向外扩展剩余核半径之后的范围，范围之外清成黑色。
   */
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
      // 取样在相邻两层之间插值，上一层已覆盖所需方差时后面的层不会被读取。
      if (previousSigma * previousSigma >= maxVariance)
        break
      // 上一级已移除高频细节，因此较宽的模糊可以使用较小的纹理。
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
      // 横向结果还要被纵向卷积读取，纵向多留一个核半径。
      this.pass(pipeline, input, sigma / width, 0, region, remaining, remaining + kernel, width, height)
      this.pass(pipeline, level.horizontal.group, 0, sigma / height, region, remaining, remaining, width, height)
      input = level.vertical.group
      previousSigma = level.sigma
    }
  }

  /** 编码 `plan()` 安排的卷积。 */
  encode(encoder: GPUCommandEncoder): void {
    for (let i = 0; i < this.passCount; i++) {
      const pass = this.passes[i]!
      const target = pass.target
      this.frame.encodePass(encoder, 'blur', target.view, target.width, target.height, CLEAR_BLACK, pass.list)
    }
  }

  /** 释放所有模糊纹理。 */
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

  /**
   * 沿指定方向安排下一遍卷积，偏移量使用归一化纹理坐标。
   * 有 `region` 时只画它向外扩展 `padX`、`padY` 之后的范围。
   */
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
