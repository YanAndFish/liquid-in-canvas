/**
 * 多级模糊的着色器与资源创建，只在舞台启动时执行。每帧的安排与编码在 `blur.hot.ts`。
 */
import type { StageGpu } from '../gpu'
import { DrawList } from '../frame.hot'
import { PipelineTable, RenderTarget, shaderPrelude, SLOT_TARGET, wgslFloat } from '../gpu'
import { BLUR_SIGMAS, gaussianKernel } from './gaussian'

/** 一层模糊的两遍绘制目标。 */
export interface BlurLevel {
  /** 目标标准差，单位为 CSS 像素。 */
  sigma: number
  /** 横向卷积结果。 */
  horizontal: RenderTarget
  /** 纵向卷积结果，也是供玻璃采样的最终纹理。 */
  vertical: RenderTarget
}

/** 一遍卷积：画到哪个目标，以及这一遍唯一的绘制项。 */
export interface BlurPass {
  target: RenderTarget
  list: DrawList
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

/** 卷积管线，只有一条。 */
export function createBlurPipeline(gpu: StageGpu): PipelineTable {
  return new PipelineTable(gpu, 'blur', () => ({
    code: BLUR_SHADER,
    entry: 'blur',
    textures: 1,
    format: gpu.formatOf(SLOT_TARGET),
  }))
}

/** 各级模糊的绘制目标，按标准差从小到大排列。 */
export function createBlurLevels(gpu: StageGpu): BlurLevel[] {
  return BLUR_SIGMAS.map(sigma => ({
    sigma,
    horizontal: new RenderTarget(gpu),
    vertical: new RenderTarget(gpu),
  }))
}

/** 每层横向、纵向各一遍，按执行顺序排列。 */
export function createBlurPasses(levels: readonly BlurLevel[]): BlurPass[] {
  return levels.flatMap(level => [
    {
      target: level.horizontal,
      list: new DrawList(),
    },
    {
      target: level.vertical,
      list: new DrawList(),
    },
  ])
}

/** 各级的最终纹理视图。 */
export function blurViews(levels: readonly BlurLevel[]): GPUTextureView[] {
  return levels.map(level => level.vertical.view)
}
