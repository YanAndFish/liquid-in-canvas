import type { StageGpu } from '../gpu'
import { DrawList } from '../frame.hot'
import { PipelineTable, RenderTarget, shaderPrelude, SLOT_TARGET, wgslFloat } from '../gpu'
import { BLUR_SIGMAS, gaussianKernel } from './gaussian'

export interface BlurLevel {
  sigma: number
  horizontal: RenderTarget
  vertical: RenderTarget
}

export interface BlurPass {
  target: RenderTarget
  list: DrawList
}

const BLUR_SHADER = /* wgsl */`${shaderPrelude(`
  step: vec4f,`)}
@group(1) @binding(0) var source: texture_2d<f32>;

@fragment
fn blur(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.position.xy / u.screen.xy;
  var sum = vec3f(0.0);
${gaussianKernel().map(tap => `  sum += textureSample(source, samp, uv + u.step.xy * ${wgslFloat(tap.offset)}).rgb * ${wgslFloat(tap.weight)};`).join('\n')}
  return vec4f(sum, 1.0);
}
`

export function createBlurPipeline(gpu: StageGpu): PipelineTable {
  return new PipelineTable(gpu, 'blur', () => ({
    code: BLUR_SHADER,
    entry: 'blur',
    textures: 1,
    format: gpu.formatOf(SLOT_TARGET),
  }))
}

export function createBlurLevels(gpu: StageGpu): BlurLevel[] {
  return BLUR_SIGMAS.map(sigma => ({
    sigma,
    horizontal: new RenderTarget(gpu),
    vertical: new RenderTarget(gpu),
  }))
}

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

export function blurViews(levels: readonly BlurLevel[]): GPUTextureView[] {
  return levels.map(level => level.vertical.view)
}
