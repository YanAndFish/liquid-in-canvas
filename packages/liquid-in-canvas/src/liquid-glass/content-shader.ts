import type { StageGpu } from '../gpu'
import { BLEND_NORMAL, PipelineTable, shaderPrelude, SLOT_CANVAS, SLOT_TARGET, wgslFloat } from '../gpu'

export const MASK_FLOATS = 12

export const MASK_SHADER = /* wgsl */`
struct Mask {
  box: vec4f,
  radius: vec4f,
  clip: vec4f,
}

fn mask_coverage(position: vec2f, mask: Mask) -> f32 {
  let local = position - mask.box.xy;
  let corner = min(select(select(mask.radius.z, mask.radius.y, local.y < 0.0), select(mask.radius.w, mask.radius.x, local.y < 0.0), local.x < 0.0), min(mask.box.z, mask.box.w));
  let q = abs(local) - mask.box.zw + corner;
  let distance = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - corner;
  let clipped = max(max(mask.clip.x - position.x, position.x - mask.clip.z), max(mask.clip.y - position.y, position.y - mask.clip.w));
  return 1.0 - smoothstep(-0.5, 0.5, max(distance, clipped));
}
`

const CONTENT_BLUR_TAPS: readonly (readonly [number, number, number])[] = (() => {
  const taps: [number, number, number][] = []
  let total = 0
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      const weight = Math.exp(-(x * x + y * y) / 2)
      taps.push([x / 2, y / 2, weight])
      total += weight
    }
  }
  return taps.map(([x, y, weight]) => [x, y, Math.round(weight / total * 1e5) / 1e5] as const)
})()

export const CONTENT_FLOATS = 16

export function createContentShader(occluders: number): string {
  const fields = `
  clip: vec4f,
  sizes: vec4f,
  params: vec4f,
  origin: vec4f,${occluders > 0
    ? `
  masks: array<Mask, ${occluders}>,`
    : ''}`
  return /* wgsl */`${shaderPrelude(fields, MASK_SHADER)}
@group(1) @binding(0) var content: texture_2d<f32>;

fn portions(in: VertexOutput, content_uv: vec2f) -> vec2f {
  let position = in.position.xy / u.screen.xy * u.screen.zw;
  let valid = content_uv.x >= 0.0 && content_uv.x <= 1.0 && content_uv.y >= 0.0 && content_uv.y <= 1.0
    && position.x >= u.clip.x && position.x <= u.clip.z && position.y >= u.clip.y && position.y <= u.clip.w;
  var coverage = 0.0;
${Array.from({ length: occluders }, (_, i) => `  coverage = max(coverage, mask_coverage(position, u.masks[${i}]));`).join('\n')}
  return vec2f(1.0 - coverage, coverage) * select(0.0, 1.0, valid) * u.params.x;
}

fn content_uv(in: VertexOutput) -> vec2f {
  let local = u.origin.xy + ((in.uv - 0.5) * u.sizes.zw - u.origin.xy) / max(u.params.y, 0.01);
  return (local + u.sizes.xy * 0.5) / u.sizes.xy;
}

fn content_sample(at: vec2f) -> vec4f {
  if (u.params.z < 0.05) {
    return textureSample(content, samp, at);
  }
  let radius = u.params.z / u.sizes.xy;
  var sum = vec4f(0.0);
${CONTENT_BLUR_TAPS.map(([x, y, w]) => `  {
    let c = textureSample(content, samp, at + vec2f(${wgslFloat(x)}, ${wgslFloat(y)}) * radius);
    sum += vec4f(c.rgb * c.a, c.a) * ${wgslFloat(w)};
  }`).join('\n')}
  return vec4f(sum.rgb / max(sum.a, 0.0001), sum.a);
}

@fragment
fn clear(in: VertexOutput) -> @location(0) vec4f {
  let at = content_uv(in);
  let pixel = content_sample(at);
  return vec4f(pixel.rgb, pixel.a * portions(in, at).x);
}

@fragment
fn occluded(in: VertexOutput) -> @location(0) vec4f {
  let at = content_uv(in);
  let pixel = content_sample(at);
  return vec4f(pixel.rgb, pixel.a * portions(in, at).y);
}
`
}

export interface ContentPipelines {
  clear: PipelineTable
  occluded: PipelineTable
  stacked: PipelineTable
}

export function createContentPipelines(gpu: StageGpu): ContentPipelines {
  return {
    clear: new PipelineTable(gpu, 'content:clear', occluders => ({
      code: createContentShader(occluders),
      entry: 'clear',
      textures: 1,
      format: gpu.formatOf(SLOT_CANVAS),
      blend: BLEND_NORMAL,
    })),
    occluded: new PipelineTable(gpu, 'content:occluded', occluders => ({
      code: createContentShader(occluders),
      entry: 'occluded',
      textures: 1,
      format: gpu.formatOf(SLOT_TARGET),
      blend: BLEND_NORMAL,
    })),
    stacked: new PipelineTable(gpu, 'content:stacked', occluders => ({
      code: createContentShader(occluders),
      entry: 'clear',
      textures: 1,
      format: gpu.formatOf(SLOT_TARGET),
      blend: BLEND_NORMAL,
    })),
  }
}
