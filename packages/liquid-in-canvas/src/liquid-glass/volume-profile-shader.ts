import { wgslFloat } from '../gpu'
import { LUT_ROWS_PER_PROFILE, LUT_SAMPLES, MAX_TRAVEL } from './optics-lut'
import { clipCoverage, each, fuseDominance, fuseOutlines, gradientArray, REFLECTION_VARIANCE, VOLUME_TEXTURES, volumeCommon } from './volume-shader'

/**
 * 剖面查表：查找表的绑定，以及按到轮廓的距离查表并着色。
 * 剖面光学的体积着色器与混合光路共用。
 */
export function profileOptics(): string {
  return /* wgsl */`
@group(1) @binding(${VOLUME_TEXTURES}) var lut: texture_2d<f32>;

// 一个像素查表所需的距离场与外观。
struct Field {
  distance: f32,
  gradient: vec2f,
  optics: vec4f,
  colored: vec4f,
  lens: vec2f,
  half_depth: f32,
  elevation: f32,
  bevel: f32,
  row: f32,
  ior: f32,
  tone: vec2f,
  // 融合处距离场的梯度长度：小于 1 时截面沿法向被拉宽，倒角的坡度按这个比例变缓。单块玻璃上为 1。
  stretch: f32,
  // 融合处厚度渐变带来的平顶与底面坡度（高度对平面坐标的梯度）。单块玻璃上为 0。
  top_slope: vec2f,
  bottom_slope: vec2f,
  // 顶面倒角的高度与曲线指数，用来算倒角上实际的厚度（只在坡度不为 0 时用到）。
  shape: vec2f,
}

fn member_bevel(m: Member) -> f32 {
  return max(min(m.profile.x, min(m.box.z, m.box.w)), 0.5);
}

// 查表坐标：样本到轮廓的距离按平方分布，这里取平方根换算回去；行内取纹素中心，不与相邻行插值。
// texel_row 是一行截面参数里的第几条纹素行：位移、斜率、有效度、玻璃内的横向范围。
fn lut_at(field: Field, texel_row: f32) -> vec4f {
  let inset = clamp(-field.distance / field.bevel, 0.0, 1.0);
  let size = vec2f(textureDimensions(lut));
  let x = (sqrt(inset) * ${wgslFloat(LUT_SAMPLES - 1)} + 0.5) / size.x;
  return textureSampleLevel(lut, samp, vec2f(x, (field.row * ${wgslFloat(LUT_ROWS_PER_PROFILE)} + texel_row + 0.5) / size.y), 0.0);
}

// 按到轮廓的距离查表并着色：返回颜色与不透明度；截面在这个位置没有实体时不透明度为 -1。
fn glass_lookup(field: Field, xy: vec2f, screen_uv: vec2f) -> vec4f {
  let viewport = u.screen.zw;
  let shift = lut_at(field, 0.0);
  let slope = lut_at(field, 1.0);
  let validity = lut_at(field, 2.0);
  if (validity.w <= 0.5) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let material_color = field.colored.rgb / max(field.optics.z, 0.0001);
  // 截面被拉宽时坡度变缓，偏移与法线的倾斜按一阶近似同比缩小。
  let offsets = clamp((shift.xyz * field.half_depth + slope.xyz * field.elevation) * field.stretch, vec3f(-${wgslFloat(MAX_TRAVEL)}), vec3f(${wgslFloat(MAX_TRAVEL)}));
  // 厚度渐变的坡度按薄棱镜近似。倒角上截面的高度只占半厚度的 c（平顶为 1、轮廓处趋于 0）：
  // 顶面坡度是中面坡度加 c 倍的半厚度坡度，底面减去同样的量，玻璃厚 2c 倍半厚度。
  // 顶面的坡度让光线在玻璃内偏向高处（偏移随厚度增长），出射后按上下表面的坡度差继续偏折。
  let bevel_u = clamp(1.0 + field.distance / field.bevel, 0.0, 1.0);
  let power = max(field.shape.y, 1.0);
  let c = 1.0 - field.shape.x / max(field.half_depth, 0.001) * (1.0 - pow(1.0 - pow(bevel_u, power), 1.0 / power));
  let half_slope = 0.5 * (field.top_slope - field.bottom_slope);
  let top_tilt = 0.5 * (field.top_slope + field.bottom_slope) + c * half_slope;
  let prism = top_tilt * ((1.0 - 1.0 / field.ior) * 2.0 * c * field.half_depth) + half_slope * (2.0 * (field.ior - 1.0) * c * field.elevation);
  let shifted = xy + field.lens + clamp(prism, vec2f(-${wgslFloat(MAX_TRAVEL)}), vec2f(${wgslFloat(MAX_TRAVEL)}));
  let red_uv = clamp((shifted + field.gradient * offsets.x) / viewport, u.valid.xy, u.valid.zw);
  let green_uv = clamp((shifted + field.gradient * offsets.y) / viewport, u.valid.xy, u.valid.zw);
  let blue_uv = clamp((shifted + field.gradient * offsets.z) / viewport, u.valid.xy, u.valid.zw);
  let transmitted = glass_tone(sample_blur_rgb(red_uv, green_uv, blue_uv, field.optics.x), field.tone);
  let normal = normalize(vec3f(field.gradient * shift.w * field.stretch - top_tilt * slope.w, slope.w));
  // 反射方向由法线决定；有限距离的页面环境近似用柔化采样表示表面粗糙度。
  let reflection = reflect(vec3f(0.0, 0.0, -1.0), normal);
  let environment_uv = clamp(screen_uv + reflection.xy * 48.0 / viewport, u.valid.xy, u.valid.zw);
  let environment = sample_blur(environment_uv, field.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
  let fresnel = 0.034 + pow(1.0 - clamp(normal.z, 0.0, 1.0), 5.0) * 0.966;
  let tinted = mix(transmitted, material_color, field.optics.z);
  let valid = validity.xyz;
  var refracted = tinted;
  if (min(valid.x, min(valid.y, valid.z)) < 1.0) {
    let local_environment = glass_tone(sample_blur(screen_uv, field.optics.x), field.tone);
    refracted = mix(mix(local_environment, material_color, field.optics.z), tinted, valid);
  }
  let reflected = mix(refracted, environment, clamp(fresnel * field.optics.w, 0.0, 1.0));
  let light = pow(max(dot(normal, normalize(vec3f(-0.45, -0.6, 0.66))), 0.0), 32.0);
  let edge = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);
  let highlight = (light * 0.035 * edge + edge * 0.035) * field.optics.w;
  return vec4f(reflected + vec3f(highlight * u.params.z), field.colored.a);
}
`
}

/** 二维平滑合并后的距离场与外观（`glass_field`），剖面光学与混合光路切换时的交叉淡化共用。 */
export function profileField(count: number): string {
  // 只有一名成员时没有 `grads` 数组。
  const firstGradient = count === 1
    ? 'c0.yz'
    : 'grads[index]'
  return /* wgsl */`
// 平滑合并后的距离场与外观。距离与外法向用平面平滑合并（与三维求交的合并轮廓相同）；
// 截面尺寸与外观由较厚成员主导（与三维求交的 glass_body、glass_material 相同），查找表的行取权重占优的成员。
fn glass_field(xy: vec2f) -> Field {
${each(count, i => `  let c${i} = glass_contour(xy, u.members[${i}]);
  let d${i} = c${i}.x;`)}
  var f: Field;
  var distance: f32;
${gradientArray(count, 'c')}
${fuseOutlines(count, `    f.gradient = ${firstGradient};`, `    f.gradient = mix(grads[index], f.gradient, h);`)}
  f.distance = distance;
  f.stretch = min(length(f.gradient), 1.0);
  f.gradient = normalize(f.gradient + vec2f(0.0, 0.00001));
${fuseDominance(count, `      f.top_slope = vec2f(0.0);
      f.bottom_slope = vec2f(0.0);
      f.optics = m.appearance;
      f.colored = m.color;
      f.lens = glass_lens(xy, m);
      f.half_depth = m.depth.x;
      f.elevation = m.depth.y;
      f.bevel = member_bevel(m);
      f.shape = m.profile.yz;
      f.row = m.extra.x;
      f.ior = m.refraction.x;
      f.tone = m.extra.yz;`, `      let w = ramp.x;
      // mix(a, c, w) 的梯度是 (1 − w)·∇a + (c − a)·∇w，∇w 是 falloff。
      f.top_slope = (1.0 - w) * f.top_slope + (m.depth.y + 2.0 * m.depth.x - f.elevation - 2.0 * f.half_depth) * falloff;
      f.bottom_slope = (1.0 - w) * f.bottom_slope + (m.depth.y - f.elevation) * falloff;
      f.optics = mix(f.optics, m.appearance, w);
      f.colored = mix(f.colored, m.color, w);
      f.lens = mix(f.lens, glass_lens(xy, m), w);
      f.half_depth = mix(f.half_depth, m.depth.x, w);
      f.elevation = mix(f.elevation, m.depth.y, w);
      f.bevel = mix(f.bevel, member_bevel(m), w);
      f.shape = mix(f.shape, m.profile.yz, w);
      f.row = select(f.row, m.extra.x, w >= 0.5);
      f.ior = mix(f.ior, m.refraction.x, w);
      f.tone = mix(f.tone, m.extra.yz, w);`, true)}
  return f;
}
`
}

/**
 * 生成指定成员数量的剖面光学体积着色器。
 *
 * 与 `createVolumeShader()` 读取同样的 uniform、取样同样的背景与模糊，外观和单块玻璃上的结果一致。
 * 区别在于光路：二维平滑合并距离场给出到轮廓的距离与外法向，再按距离查 `optics-lut.ts` 预先追踪的
 * 截面光路，没有逐步求交与有限差分法线。每个像素的开销与成员数量成正比，与倒角和融合区域无关。
 * 比体积着色器多取样一张查找表，绑定在所有模糊之后。
 */
export function createProfileVolumeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${profileOptics()}
${profileField(count)}
// 只求平滑合并后的距离，用于阴影。
fn glass_projection(xy: vec2f) -> f32 {
${each(count, i => `  let d${i} = glass_outline(xy, u.members[${i}]);`)}
  var distance: f32;
${fuseOutlines(count, '', '')}
  return distance;
}

@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
  let field = glass_field(xy);
  let shadow_distance = glass_projection(xy - vec2f(0.0, 4.0));
  var shadow_alpha = exp(max(shadow_distance, 0.0) / max(u.shadow.y, 1.0) * -4.0) * u.shadow.x;
  if (field.distance > 0.0 && shadow_alpha > 0.002) {
    shadow_alpha *= shadow_strength(screen_uv, u.members[0].appearance.x);
  }
  var result = vec4f(0.0, 0.0, 0.0, shadow_alpha);
  let coverage = 1.0 - smoothstep(-0.7, 0.3, field.distance);
  if (field.distance < 0.02) {
    let looked = glass_lookup(field, xy, screen_uv);
    if (looked.a >= 0.0) {
      result = vec4f(looked.rgb, looked.a * coverage);
    }
  }
${clipCoverage(count)}
  return vec4f(result.rgb, result.a * clip_coverage);
}
`
}
