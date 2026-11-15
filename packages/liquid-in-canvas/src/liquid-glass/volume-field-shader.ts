import { hybridOwner, hybridTier } from './volume-hybrid-shader'
import { profileOptics } from './volume-profile-shader'
import { raymarchOptics, volumeCommon } from './volume-shader'

/** 折射场缓存的纹理数量，每张都是半精度四通道。 */
export const FIELD_TARGETS = 3

/**
 * 生成写入折射场缓存的着色器。
 *
 * 混合光路里求交档的像素，求交得到的量与背景无关：三条光路落在背景平面上的位置、入射法线、
 * 各条光路的有效程度、入射点的高度。成员之间的相对位置不变时这些量也不变，所以求交一次、
 * 写进按组的局部坐标存放的纹理，之后每帧只读回来，再照常取样背景与模糊（背景与视频仍然每帧更新）。
 *
 * 三张纹理的内容：
 *
 * - 第 0 张：红、绿两条光路的落点相对像素的偏移。
 * - 第 1 张：蓝色光路的偏移，入射法线的 xy（z 不小于零，读取时还原）。
 * - 第 2 张：三条光路的有效程度，入射点的高度。高度为负表示这个纹素没有可用的光路：
 *   不在求交档（平顶与查表每帧现算），或视线没有碰到实体（轮廓上的一圈像素，读取时仍然逐步求交）。
 *
 * 外观（染色、模糊方差、透镜偏移）不写进缓存：读取时按入射点重新算一次平滑合并权重，
 * 压暗、淡入淡出与主题变化都不需要重新求交。
 *
 * uniform 与混合着色器相同，成员的位置换成相对缓存左上角的坐标；`screen` 是缓存的纹素尺寸与 CSS 尺寸。
 */
export function createFieldBakeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}${profileOptics()}
struct FieldOutput {
  @location(0) first: vec4f,
  @location(1) rest: vec4f,
  @location(2) stored: vec4f,
}

@fragment
fn bake(in: VertexOutput) -> FieldOutput {
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * u.screen.zw;
${hybridOwner(count)}
  var out: FieldOutput;
  out.first = vec4f(0.0);
  out.rest = vec4f(0.0);
  out.stored = vec4f(0.0, 0.0, 0.0, -1.0);
  if (outline < 0.02) {
${hybridTier()}
    if (!on_slab && !alone) {
      let entry = glass_entry(xy);
      if (entry.w > 0.5) {
        let material = glass_material(entry.xyz);
        let paths = glass_paths(entry.xyz, material.optics.y * 0.055);
        out.first = vec4f(paths.red.xy - xy, paths.green.xy - xy);
        out.rest = vec4f(paths.blue.xy - xy, paths.normal.xy);
        out.stored = vec4f(paths.red.z, paths.green.z, paths.blue.z, max(entry.z, 0.0));
      }
    }
  }
  return out;
}
`
}
