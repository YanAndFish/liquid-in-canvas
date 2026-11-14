import type { DrawItem, StageGpu } from '../gpu'
import { HEADER_FLOATS, RenderTarget, shaderPrelude, TARGET_FORMAT, wgslFloat } from '../gpu'
import { BLUR_SIGMAS, gaussianKernel, incrementalSigma } from './gaussian'

/** 一层模糊的两遍绘制目标。 */
interface BlurLevel {
  /** 目标标准差，单位为 CSS 像素。 */
  sigma: number
  /** 横向卷积结果。 */
  horizontal: RenderTarget
  /** 纵向卷积结果，也是供玻璃采样的最终纹理。 */
  vertical: RenderTarget
}

/** 一遍卷积：画到哪个目标，取样哪张纹理。 */
interface BlurPass {
  target: RenderTarget
  item: DrawItem
}

/** 沿 `step` 方向的一维高斯卷积，偏移量使用归一化纹理坐标。 */
const BLUR_SHADER = /* wgsl */`${shaderPrelude(`
  // 相隔一个标准差的两个采样点在纹理坐标中的距离。
  step: vec4f,`)}
@group(1) @binding(0) var source: texture_2d<f32>;

@fragment
fn blur(in: VertexOutput) -> @location(0) vec4f {
  var sum = vec3f(0.0);
${gaussianKernel().map(tap => `  sum += textureSample(source, samp, in.uv + u.step.xy * ${wgslFloat(tap.offset)}).rgb * ${wgslFloat(tap.weight)};`).join('\n')}
  return vec4f(sum, 1.0);
}
`

/** 逐级卷积页面背景，生成与设备像素密度无关的高斯模糊纹理。 */
export class BackdropBlur {
  /** 任意一层的纹理被重新创建时加一，取样这些纹理的绑定需要随之重建。 */
  generation = 0
  private readonly gpu: StageGpu
  private readonly levels: BlurLevel[]
  private passes: BlurPass[] = []
  private disposed = false

  constructor(gpu: StageGpu) {
    this.gpu = gpu
    this.levels = BLUR_SIGMAS.map(sigma => ({
      sigma,
      horizontal: new RenderTarget(gpu),
      vertical: new RenderTarget(gpu),
    }))
  }

  /** 按标准差从小到大返回模糊纹理。 */
  get views(): GPUTextureView[] {
    return this.levels.map(level => level.vertical.view)
  }

  /**
   * 使用 CSS 视口尺寸计算采样间距，安排本帧要生成的各级模糊。
   *
   * `source` 是只取样背景的绑定。`maxVariance` 是本帧玻璃会取样的最大方差；
   * 上一层已经覆盖它时，后面的层不再生成。
   */
  plan(source: GPUBindGroup, width: number, height: number, maxVariance = Infinity): void {
    this.passes = []
    if (this.disposed || width < 1 || height < 1)
      return
    const pipeline = this.gpu.pipeline('blur', () => ({
      code: BLUR_SHADER,
      entry: 'blur',
      textures: 1,
      format: TARGET_FORMAT,
    }))
    let input = source
    let previousSigma = 0
    for (const level of this.levels) {
      // 取样在相邻两层之间插值，上一层已覆盖所需方差时后面的层不会被读取。
      if (previousSigma * previousSigma >= maxVariance)
        break
      // 上一级已移除高频细节，因此较宽的模糊可以使用较小的纹理。
      const downsample = Math.min(level.sigma, 16)
      const targetWidth = Math.max(1, Math.ceil(width / downsample))
      const targetHeight = Math.max(1, Math.ceil(height / downsample))
      const resized = level.horizontal.resize(targetWidth, targetHeight)
      if (level.vertical.resize(targetWidth, targetHeight) || resized)
        this.generation++
      const sigma = incrementalSigma(previousSigma, level.sigma)
      this.pass(pipeline, input, level.horizontal, sigma / width, 0)
      this.pass(pipeline, level.horizontal.group, level.vertical, 0, sigma / height)
      input = level.vertical.group
      previousSigma = level.sigma
    }
  }

  /** 编码 `plan()` 安排的卷积。 */
  encode(encoder: GPUCommandEncoder): void {
    for (const pass of this.passes)
      this.gpu.encodePass(encoder, 'blur', pass.target, { r: 0, g: 0, b: 0, a: 1 }, [pass.item])
  }

  /** 释放所有模糊纹理。 */
  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.passes = []
    for (const level of this.levels) {
      level.horizontal.dispose()
      level.vertical.dispose()
    }
  }

  /** 沿指定方向安排一遍卷积。 */
  private pass(pipeline: GPURenderPipeline, source: GPUBindGroup, target: RenderTarget, x: number, y: number): void {
    const start = this.gpu.allocUniform(HEADER_FLOATS + 4, {
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
      targetWidth: target.width,
      targetHeight: target.height,
      cssWidth: 1,
      cssHeight: 1,
    })
    const data = this.gpu.arena.data
    data[start + 8] = x
    data[start + 9] = y
    this.passes.push({
      target,
      item: {
        order: 0,
        pipeline,
        uniform: start * 4,
        textures: source,
      },
    })
  }
}
