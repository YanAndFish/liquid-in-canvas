import { wgslFloat } from '../gpu'
import { DISPERSION_SPREAD } from './optics-lut'
import { hybridOwner, hybridTier } from './volume-hybrid-shader'
import { profileOptics } from './volume-profile-shader'
import { raymarchOptics, volumeCommon } from './volume-shader'

/**
 * 折射场缓存的各张纹理的格式。
 *
 * 光路落点的偏移可以有几百像素，半精度在 512 以上只有半个像素的精度，没有模糊的背景上看得出来，
 * 所以绿色光路的偏移（与法线）用单精度；红、蓝两条光路只存相对绿色的差，通常只有几十像素，半精度足够。
 * 三张合计 32 字节，正好是 WebGPU 缺省的 `maxColorAttachmentBytesPerSample`，不需要向设备申请更高的限制。
 */
export const FIELD_FORMATS: readonly GPUTextureFormat[] = ['rgba32float', 'rgba16float', 'rgba16float']
/** 折射场缓存的纹理数量。 */
export const FIELD_TARGETS = FIELD_FORMATS.length
/** 每个纹素在三张纹理里共占的字节数，不超过 32（一次绘制的颜色附件合计的缺省上限）。 */
export const FIELD_TEXEL_BYTES = 16 + 8 + 8

/**
 * 生成写入折射场缓存的着色器。
 *
 * 混合光路里求交档的像素，求交得到的量与背景无关：三条光路落在背景平面上的位置、入射法线、
 * 各条光路的有效程度、入射点的高度。成员之间的相对位置不变时这些量也不变，所以求交一次、
 * 写进按组的局部坐标存放的纹理，之后每帧只读回来，再照常取样背景与模糊（背景与视频仍然每帧更新）。
 *
 * 三张纹理的内容（格式见 `FIELD_FORMATS`）：
 *
 * - 第 0 张：绿色光路的落点相对像素的偏移，入射法线的 xy（z 不小于零，读取时还原）。
 * - 第 1 张：红、蓝两条光路的落点相对绿色落点的偏移。
 * - 第 2 张：三条光路的有效程度，入射点的高度。高度为负表示这个纹素没有可用的光路：
 *   不在求交档（平顶与查表每帧现算），或视线没有碰到实体（轮廓上的一圈像素，读取时仍然逐步求交）。
 *
 * 外观（染色、模糊方差、透镜偏移）不写进缓存：读取时按入射点重新算一次平滑合并权重，
 * 压暗、淡入淡出与主题变化都不需要重新求交。
 *
 * uniform 与这一组的主绘制相同（成员用视口坐标，`screen` 是主绘制的目标尺寸），`field.xy` 是缓存左上角在
 * 主绘制目标上的像素位置：纹素加上它就是画面上的像素，求交的坐标与逐帧求交逐位相同。
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
  // 换算成画面上对应像素的坐标，与混合着色器的计算逐位相同。
  let screen_uv = (in.position.xy + u.field.xy) / u.screen.xy;
  let xy = screen_uv * u.screen.zw;
${hybridOwner()}
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
        let paths = glass_paths(entry.xyz, material.ior, material.optics.y * ${wgslFloat(DISPERSION_SPREAD)});
        out.first = vec4f(paths.green.xy - xy, paths.normal.xy);
        out.rest = vec4f(paths.red.xy - paths.green.xy, paths.blue.xy - paths.green.xy);
        out.stored = vec4f(paths.red.z, paths.green.z, paths.blue.z, max(entry.z, 0.0));
      }
    }
  }
  return out;
}
`
}
