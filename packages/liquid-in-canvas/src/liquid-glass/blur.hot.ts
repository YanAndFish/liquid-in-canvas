import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, StageGpu } from '../gpu'
import type { BlurLevel, BlurPass } from './blur-shader'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { blurViews, createBlurLevels, createBlurPasses, createBlurPipeline } from './blur-shader'
import { incrementalSigma } from './gaussian'

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
   * 上一层已经覆盖它时，后面的层不再生成。
   */
  plan(source: GPUBindGroup, width: number, height: number, maxVariance: number): void {
    this.passCount = 0
    if (this.disposed || width < 1 || height < 1)
      return
    const pipeline = this.pipeline.get(0)
    let input = source
    let previousSigma = 0
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
      this.pass(pipeline, input, sigma / width, 0)
      this.pass(pipeline, level.horizontal.group, 0, sigma / height)
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

  /** 沿指定方向安排下一遍卷积，偏移量使用归一化纹理坐标。 */
  private pass(pipeline: GPURenderPipeline, source: GPUBindGroup, x: number, y: number): void {
    const pass = this.passes[this.passCount++]!
    const start = this.frame.full(HEADER_FLOATS + 4, pass.target.width, pass.target.height)
    const data = this.frame.data
    data[start + 8] = x
    data[start + 9] = y
    pass.list.reset()
    pass.list.push(0, pipeline, start * 4, source)
  }
}
