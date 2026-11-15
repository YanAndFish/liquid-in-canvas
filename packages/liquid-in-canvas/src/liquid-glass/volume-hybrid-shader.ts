import { wgslFloat } from '../gpu'
import { profileOptics } from './volume-profile-shader'
import { clipCoverage, each, raymarchOptics, REFLECTION_VARIANCE, volumeCommon } from './volume-shader'

/**
 * 查找表里的横向范围换算成像素时乘的余量与附加的像素数。
 * 查找表在参考厚度下追踪，步长与阈值以像素为单位，换到别的厚度时只是近似成比例；
 * 另外要盖住有限差分法线与全内反射后那一步的位移。
 */
export const HYBRID_REACH_SCALE = 1.1
export const HYBRID_REACH_PAD = 2

/**
 * 生成指定成员数量的混合光路体积着色器：逐像素在平顶捷径、剖面查表与三维求交之间选择。
 *
 * 融合只在成员彼此靠近的地方改变实体的形状，裁剪也只在裁剪边附近切开实体。离它们足够远的像素上，
 * 光路只穿过一名成员，结果与这名成员单独存在时相同，可以直接查表；其余像素逐步求交。
 * 每个像素按到各成员轮廓（含裁剪）的距离找出最近与次近的成员，分三档：
 *
 * - 平顶：落在最近成员的倒角内侧，次近成员不参与平滑合并。光线垂直穿过等厚平板。
 * - 查表：次近成员与裁剪边离得比“平滑合并的范围 + 光线在玻璃内的横向位移”更远。
 *   横向位移取自查找表里这个位置的追踪结果，轮廓附近发生全内反射的光线走得远，倒角内侧接近零。
 * - 求交：其余像素，也就是融合连接处与裁剪边附近。
 *
 * 判定条件保证查表的像素上三维距离场与只有这名成员时逐点相同，两档交界处的结果一致，
 * 成员移动时交界随之连续移动。覆盖率与阴影在三档里用同一个投影距离，轮廓没有接缝。
 *
 * 读取的 uniform 与纹理和剖面光学相同。`params.w` 是其余成员不参与平滑合并的最小距离。
 */
export function createHybridVolumeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}${profileOptics()}
@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
  // 每名成员的轮廓距离只算一次：合并出投影距离（与 glass_projection 相同），同时找出最近与次近的成员。
  var owner = 0;
  var nearest = 0.0;
  var second = 1000000.0;
  var outline = 0.0;
  var fusion = u.members[0].depth.z;
  {
    let m = u.members[0];
    let planar = glass_outline(xy, m.box, m.radius);
    let clipped = glass_clip(xy, m.clip);
    outline = max(glass_section(planar, 0.0, m), clipped);
    nearest = max(planar, clipped);
  }
${each(count, i => `  {
    let m = u.members[${i}];
    let planar = glass_outline(xy, m.box, m.radius);
    let clipped = glass_clip(xy, m.clip);
    let other = max(glass_section(planar, 0.0, m), clipped);
    let k = max(min(fusion, m.depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other - outline) / k, 0.0, 1.0);
    outline = mix(other, outline, h) - k * h * (1.0 - h);
    fusion = max(fusion, m.depth.z);
    let apart = max(planar, clipped);
    if (apart < nearest) {
      second = nearest;
      nearest = apart;
      owner = ${i};
    } else {
      second = min(second, apart);
    }
  }`, 1)}
  let distance = glass_projection(xy - vec2f(0.0, 4.0));
  var shadow_alpha = exp(max(distance, 0.0) / max(u.shadow.y, 1.0) * -4.0) * u.shadow.x;
  if (outline > 0.0 && shadow_alpha > 0.002) {
    shadow_alpha *= shadow_strength(screen_uv, u.members[0].appearance.x);
  }
  var result = vec4f(0.0, 0.0, 0.0, shadow_alpha);
  let coverage = 1.0 - smoothstep(-0.7, 0.3, outline);
  if (outline < 0.02) {
    let m = u.members[owner];
    let contour = outline_gradient(xy, m.box, m.radius);
    let clipped = glass_clip(xy, m.clip);
    var field: Field;
    field.distance = contour.x;
    field.gradient = contour.yz;
    field.optics = m.appearance;
    field.colored = m.color;
    field.lens = glass_lens(xy, m);
    field.half_depth = m.depth.x;
    field.elevation = m.depth.y;
    field.bevel = member_bevel(m);
    field.row = m.extra.x;
    field.tone = m.extra.yz;
    if (contour.x + field.bevel < -0.5 && clipped < -1.0 && second >= u.params.w) {
      // 平顶：光线垂直穿过等厚平板，只受透镜偏移影响，没有轮廓高光。其余成员不参与合并，外观就是这名成员的。
      let here = clamp(screen_uv, u.valid.xy, u.valid.zw);
      let through = clamp(screen_uv + field.lens / viewport, u.valid.xy, u.valid.zw);
      let transmitted = glass_tone(sample_blur(through, m.appearance.x), field.tone);
      let environment = sample_blur(here, m.appearance.x + ${wgslFloat(REFLECTION_VARIANCE)});
      let color = m.color.rgb / max(m.appearance.z, 0.0001);
      let reflected = mix(mix(transmitted, color, m.appearance.z), environment, clamp(m.appearance.w * 0.034, 0.0, 1.0));
      result = vec4f(reflected, m.color.a * coverage);
    } else {
      // 光线在玻璃内离开入射位置的最大横向距离。裁剪边还要再远一个半厚度，
      // 否则它会成为距离场里最近的面，求交的步长随之变小。
      let lateral = lut_at(field, 3.0).x * m.depth.x * ${wgslFloat(HYBRID_REACH_SCALE)} + ${wgslFloat(HYBRID_REACH_PAD)};
      var shaded = vec4f(0.0, 0.0, 0.0, -1.0);
      if (second >= u.params.w + lateral && clipped <= -(lateral + m.depth.x)) {
        shaded = glass_lookup(field, xy, screen_uv);
      } else {
        shaded = glass_trace(xy, screen_uv);
      }
      if (shaded.a >= 0.0) {
        result = vec4f(shaded.rgb, shaded.a * coverage);
      }
    }
  }
${clipCoverage(count)}
  return vec4f(result.rgb, result.a * clip_coverage);
}
`
}
