import type { StageGpu } from '../gpu'
import { BLEND_NORMAL, PipelineTable, shaderPrelude, SLOT_CANVAS, SLOT_TARGET } from '../gpu'

/** 每块上层玻璃的轮廓占用的浮点数个数，对应着色器里的 `Mask`。 */
export const MASK_FLOATS = 12

/** 上层玻璃轮廓的结构体，以及屏幕坐标处的覆盖比例；边缘使用亚像素过渡。 */
export const MASK_SHADER = /* wgsl */`
struct Mask {
  // 中心坐标与半宽高。
  box: vec4f,
  // 左上、右上、右下、左下的圆角半径。
  radius: vec4f,
  // 裁剪范围：左、上、右、下。
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

/** 内容 uniform 中矩形与目标尺寸之后、遮挡轮廓之前的浮点数个数。 */
export const CONTENT_FLOATS = 12

/**
 * 生成指定遮挡数量的内容着色器。
 *
 * HTML 快照被分成两部分：没有被上层玻璃覆盖的清晰内容直接画到画布上；
 * 被覆盖的部分写进背景，参与上层玻璃的折射与模糊。
 */
export function createContentShader(occluders: number): string {
  const fields = `
  // 可绘制范围：左、上、右、下。
  clip: vec4f,
  // 内容的宽高，以及含四周余量的绘制矩形宽高。
  sizes: vec4f,
  // 不透明度。
  params: vec4f,${occluders > 0
    ? `
  masks: array<Mask, ${occluders}>,`
    : ''}`
  return /* wgsl */`${shaderPrelude(fields, MASK_SHADER)}
@group(1) @binding(0) var content: texture_2d<f32>;

// x 是没有被上层玻璃覆盖的比例乘以不透明度，y 是被覆盖的比例乘以不透明度。
fn portions(in: VertexOutput, content_uv: vec2f) -> vec2f {
  let position = in.position.xy / u.screen.xy * u.screen.zw;
  let valid = content_uv.x >= 0.0 && content_uv.x <= 1.0 && content_uv.y >= 0.0 && content_uv.y <= 1.0
    && position.x >= u.clip.x && position.x <= u.clip.z && position.y >= u.clip.y && position.y <= u.clip.w;
  var coverage = 0.0;
${Array.from({ length: occluders }, (_, i) => `  coverage = max(coverage, mask_coverage(position, u.masks[${i}]));`).join('\n')}
  return vec2f(1.0 - coverage, coverage) * select(0.0, 1.0, valid) * u.params.x;
}

fn content_uv(in: VertexOutput) -> vec2f {
  let local = (in.uv - 0.5) * u.sizes.zw;
  return (local + u.sizes.xy * 0.5) / u.sizes.xy;
}

@fragment
fn clear(in: VertexOutput) -> @location(0) vec4f {
  let at = content_uv(in);
  let pixel = textureSample(content, samp, at);
  return vec4f(pixel.rgb, pixel.a * portions(in, at).x);
}

@fragment
fn occluded(in: VertexOutput) -> @location(0) vec4f {
  let at = content_uv(in);
  let pixel = textureSample(content, samp, at);
  return vec4f(pixel.rgb, pixel.a * portions(in, at).y);
}
`
}

/**
 * 内容的两条管线表，按遮挡数量取用：清晰内容画进画布，被覆盖的内容画进背景的离屏副本。
 */
export interface ContentPipelines {
  clear: PipelineTable
  occluded: PipelineTable
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
  }
}
