import type { DrawItem, FrameHeader, StageGpu } from '../gpu'
import type { VolumeSurface } from './fusion'
import { BLEND_NORMAL, HEADER_FLOATS, shaderPrelude } from '../gpu'
import { MASK_FLOATS, MASK_SHADER, writeContentMask } from './content-mask'

/** 玻璃上的一块 HTML 内容在本帧的位置与状态，长度使用 CSS 像素。 */
export interface GlassContent {
  /** 内容矩形（玻璃元素自身）的左上角与尺寸。 */
  left: number
  top: number
  width: number
  height: number
  /** 绘制矩形在内容四周留出的余量。 */
  padding: number
  /** 可绘制范围：左、上、右、下。 */
  clip: readonly [number, number, number, number]
  /** 内容的不透明度。 */
  opacity: number
  /** 覆盖这块内容的上层玻璃。 */
  occluders: readonly VolumeSurface[]
  /** 只取样内容快照的绑定。 */
  textures: GPUBindGroup
}

/** 内容 uniform 中矩形与目标尺寸之后、遮挡轮廓之前的浮点数个数。 */
const CONTENT_FLOATS = 12

/**
 * 生成指定遮挡数量的内容着色器。
 *
 * HTML 快照被分成两部分：没有被上层玻璃覆盖的清晰内容直接画到画布上；
 * 被覆盖的部分写进背景，参与上层玻璃的折射与模糊。
 */
function createContentShader(occluders: number): string {
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

/** 内容的哪一部分：`clear` 是没有被覆盖的清晰内容，`occluded` 是被上层玻璃覆盖的内容。 */
export type ContentPart = 'clear' | 'occluded'

function contentSpec(occluders: number, part: ContentPart, format: GPUTextureFormat) {
  return () => ({
    code: createContentShader(occluders),
    entry: part,
    textures: 1,
    format,
    blend: BLEND_NORMAL,
  })
}

function contentKey(occluders: number, part: ContentPart, format: GPUTextureFormat): string {
  return `content:${occluders}:${part}:${format}`
}

/** 在后台编译指定遮挡数量的内容管线。 */
export function warmContentPipeline(gpu: StageGpu, occluders: number, part: ContentPart, format: GPUTextureFormat): void {
  gpu.warm(contentKey(occluders, part, format), contentSpec(occluders, part, format))
}

/**
 * 把一块内容写入本帧的 uniform，返回可在不同目标上复用的绘制项工厂。
 *
 * 管线按遮挡数量缓存，遮挡数量变化时不会重新编译已经用过的组合。
 */
export function planGlassContent(
  gpu: StageGpu,
  content: GlassContent,
  target: Pick<FrameHeader, 'targetWidth' | 'targetHeight' | 'cssWidth' | 'cssHeight'>,
): (part: ContentPart, format: GPUTextureFormat, order: number) => DrawItem {
  const occluders = content.occluders.length
  const start = gpu.allocUniform(HEADER_FLOATS + CONTENT_FLOATS + occluders * MASK_FLOATS, {
    left: content.left - content.padding,
    top: content.top - content.padding,
    right: content.left + content.width + content.padding,
    bottom: content.top + content.height + content.padding,
    ...target,
  })
  const data = gpu.arena.data
  let offset = start + HEADER_FLOATS
  data.set(content.clip, offset)
  data[offset + 4] = content.width
  data[offset + 5] = content.height
  data[offset + 6] = content.width + content.padding * 2
  data[offset + 7] = content.height + content.padding * 2
  data[offset + 8] = content.opacity
  offset += CONTENT_FLOATS
  for (const surface of content.occluders) {
    writeContentMask(data, offset, surface)
    offset += MASK_FLOATS
  }
  return (part, format, order) => ({
    order,
    pipeline: gpu.pipeline(contentKey(occluders, part, format), contentSpec(occluders, part, format)),
    uniform: start * 4,
    textures: content.textures,
  })
}
