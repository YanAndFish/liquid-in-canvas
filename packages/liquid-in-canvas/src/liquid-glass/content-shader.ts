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

export const CONTENT_FLOATS = 28

export function createContentShader(occluders: number): string {
  const fields = `
  clip: vec4f,
  sizes: vec4f,
  params: vec4f,
  origin: vec4f,
  shape: vec4f,
  radius: vec4f,
  morph: vec4f,${occluders > 0
    ? `
  masks: array<Mask, ${occluders}>,`
    : ''}`
  return /* wgsl */`${shaderPrelude(fields, MASK_SHADER)}
@group(1) @binding(0) var content: texture_2d<f32>;

struct ContentShape {
  sdf: f32,
  normal: vec2f,
  edge: f32,
  band: f32,
}

fn content_shape(position: vec2f) -> ContentShape {
  let local = position - u.shape.xy;
  let narrow = max(min(u.shape.z, u.shape.w), 0.5);
  let corner = min(select(select(u.radius.z, u.radius.y, local.y < 0.0), select(u.radius.w, u.radius.x, local.y < 0.0), local.x < 0.0), narrow);
  let q = abs(local) - u.shape.zw + corner;
  let sdf = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - corner;
  let band = max(u.morph.z, min(narrow * 0.45, 24.0));
  let smooth_r = clamp(max(corner, band), 0.5, narrow);
  let qw = abs(local) - u.shape.zw + smooth_r;
  let side = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), qw.x > qw.y);
  let corner_n = max(qw, vec2f(0.0));
  let corner_len = length(corner_n);
  let unit = select(side, corner_n / max(corner_len, 0.0001), corner_len > 0.0001);
  let normal = unit * vec2f(select(-1.0, 1.0, local.x >= 0.0), select(-1.0, 1.0, local.y >= 0.0));
  let depth = max(-sdf, 0.0);
  let edge = 1.0 - clamp(depth / max(band, 1.0), 0.0, 1.0);
  return ContentShape(sdf, normal, edge, band);
}

fn portions(position: vec2f, content_uv: vec2f, shape: ContentShape) -> vec2f {
  let valid = content_uv.x >= 0.0 && content_uv.x <= 1.0 && content_uv.y >= 0.0 && content_uv.y <= 1.0
    && position.x >= u.clip.x && position.x <= u.clip.z && position.y >= u.clip.y && position.y <= u.clip.w;
  let shape_alpha = select(1.0, 1.0 - smoothstep(-0.75, 0.5, shape.sdf), u.morph.x > 0.5);
  var coverage = 0.0;
${Array.from({ length: occluders }, (_, i) => `  coverage = max(coverage, mask_coverage(position, u.masks[${i}]));`).join('\n')}
  return vec2f(1.0 - coverage, coverage) * select(0.0, 1.0, valid) * shape_alpha * u.params.x;
}

fn content_uv(in: VertexOutput, shape: ContentShape) -> vec2f {
  let bend = shape.edge * shape.edge;
  let shift = shape.normal * (u.morph.y * shape.band * 0.56 * bend);
  let pos = (in.uv - 0.5) * u.sizes.zw - u.origin.zw - shift;
  let scale = max(u.params.yz, vec2f(0.01));
  let local = u.origin.xy + (pos - u.origin.xy) / scale;
  return (local + u.sizes.xy * 0.5) / max(u.sizes.xy, vec2f(1.0));
}

fn content_sample(at: vec2f, edge: f32) -> vec4f {
  if (u.params.w < 0.05 && u.morph.y < 0.005) {
    return textureSample(content, samp, at);
  }
  let blur = u.params.w + u.morph.y * edge * edge * 2.5;
  if (blur < 0.05) {
    return textureSampleLevel(content, samp, at, 0.0);
  }
  let radius = blur / max(u.sizes.xy, vec2f(1.0));
  var sum = vec4f(0.0);
${CONTENT_BLUR_TAPS.map(([x, y, w]) => `  {
    let c = textureSampleLevel(content, samp, at + vec2f(${wgslFloat(x)}, ${wgslFloat(y)}) * radius, 0.0);
    sum += vec4f(c.rgb * c.a, c.a) * ${wgslFloat(w)};
  }`).join('\n')}
  return vec4f(sum.rgb / max(sum.a, 0.0001), sum.a);
}

@fragment
fn clear(in: VertexOutput) -> @location(0) vec4f {
  let position = in.position.xy / u.screen.xy * u.screen.zw;
  var shape = ContentShape(-1.0, vec2f(0.0), 0.0, 1.0);
  if (u.morph.x > 0.5 || u.morph.y > 0.001) {
    shape = content_shape(position);
  }
  let at = content_uv(in, shape);
  let pixel = content_sample(at, shape.edge);
  return vec4f(pixel.rgb, pixel.a * portions(position, at, shape).x);
}

@fragment
fn occluded(in: VertexOutput) -> @location(0) vec4f {
  let position = in.position.xy / u.screen.xy * u.screen.zw;
  var shape = ContentShape(-1.0, vec2f(0.0), 0.0, 1.0);
  if (u.morph.x > 0.5 || u.morph.y > 0.001) {
    shape = content_shape(position);
  }
  let at = content_uv(in, shape);
  let pixel = content_sample(at, shape.edge);
  return vec4f(pixel.rgb, pixel.a * portions(position, at, shape).y);
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
