import { wgslFloat } from '../gpu'
import { LUT_ROWS_PER_PROFILE, LUT_SAMPLES, MAX_TRAVEL } from './optics-lut'
import { REFLECTION_VARIANCE, VOLUME_TEXTURES, volumeCommon } from './volume-shader'

/** 依次对每个成员展开一段代码。 */
function each(count: number, body: (i: number) => string, from = 0): string {
  return Array.from({ length: count - from }, (_, j) => body(j + from)).join('\n')
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
  return /* wgsl */`${volumeCommon(count)}
@group(1) @binding(${VOLUME_TEXTURES}) var lut: texture_2d<f32>;

// 圆角矩形的有向距离与外法向（距离场的梯度）。
fn outline_gradient(xy: vec2f, b: vec4f, radii: vec4f) -> vec3f {
  let local = xy - b.xy;
  let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), min(b.z, b.w));
  let w = abs(local) - b.zw + radius;
  let g = max(w.x, w.y);
  let q = max(w, vec2f(0.0));
  let l = length(q);
  let side = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  let inner = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), w.x > w.y);
  let gradient = select(inner, q / max(l, 0.00001), g > 0.0) * side;
  return vec3f(select(g, l, g > 0.0) - radius, gradient);
}

// 平滑合并后的距离场与外观。外观、截面尺寸与距离用同一个合并权重；查找表的行取权重占优的成员。
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
  tone: vec2f,
}

fn member_bevel(m: Member) -> f32 {
  return max(min(m.profile.x, min(m.box.z, m.box.w)), 0.5);
}

fn glass_field(xy: vec2f) -> Field {
  let first = outline_gradient(xy, u.members[0].box, u.members[0].radius);
  var f: Field;
  f.distance = first.x;
  f.gradient = first.yz;
  f.optics = u.members[0].appearance;
  f.colored = u.members[0].color;
  f.lens = glass_lens(xy, u.members[0]);
  f.half_depth = u.members[0].depth.x;
  f.elevation = u.members[0].depth.y;
  f.bevel = member_bevel(u.members[0]);
  f.row = u.members[0].extra.x;
  f.tone = u.members[0].extra.yz;
  var fusion = u.members[0].depth.z;
${each(count, i => `  {
    let m = u.members[${i}];
    let other = outline_gradient(xy, m.box, m.radius);
    let k = max(min(fusion, m.depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other.x - f.distance) / k, 0.0, 1.0);
    f.optics = mix(m.appearance, f.optics, h);
    f.colored = mix(m.color, f.colored, h);
    f.lens = mix(glass_lens(xy, m), f.lens, h);
    f.half_depth = mix(m.depth.x, f.half_depth, h);
    f.elevation = mix(m.depth.y, f.elevation, h);
    f.bevel = mix(member_bevel(m), f.bevel, h);
    f.row = select(m.extra.x, f.row, h >= 0.5);
    f.tone = mix(m.extra.yz, f.tone, h);
    f.gradient = mix(other.yz, f.gradient, h);
    f.distance = mix(other.x, f.distance, h) - k * h * (1.0 - h);
    fusion = max(fusion, m.depth.z);
  }`, 1)}
  f.gradient = normalize(f.gradient + vec2f(0.0, 0.00001));
  return f;
}

// 只求平滑合并后的距离，用于阴影。
fn glass_projection(xy: vec2f) -> f32 {
  var distance = glass_outline(xy, u.members[0].box, u.members[0].radius);
  var fusion = u.members[0].depth.z;
${each(count, i => `  {
    let m = u.members[${i}];
    let other = glass_outline(xy, m.box, m.radius);
    let k = max(min(fusion, m.depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
    distance = mix(other, distance, h) - k * h * (1.0 - h);
    fusion = max(fusion, m.depth.z);
  }`, 1)}
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
    // 查表坐标：样本到轮廓的距离按平方分布，这里取平方根换算回去；行内取纹素中心，不与相邻行插值。
    let inset = clamp(-field.distance / field.bevel, 0.0, 1.0);
    let size = vec2f(textureDimensions(lut));
    let x = (sqrt(inset) * ${wgslFloat(LUT_SAMPLES - 1)} + 0.5) / size.x;
    let base = field.row * ${wgslFloat(LUT_ROWS_PER_PROFILE)};
    let shift = textureSampleLevel(lut, samp, vec2f(x, (base + 0.5) / size.y), 0.0);
    let slope = textureSampleLevel(lut, samp, vec2f(x, (base + 1.5) / size.y), 0.0);
    let validity = textureSampleLevel(lut, samp, vec2f(x, (base + 2.5) / size.y), 0.0);
    if (validity.w > 0.5) {
      let material_color = field.colored.rgb / max(field.optics.z, 0.0001);
      let offsets = clamp(shift.xyz * field.half_depth + slope.xyz * field.elevation, vec3f(-${wgslFloat(MAX_TRAVEL)}), vec3f(${wgslFloat(MAX_TRAVEL)}));
      let red_uv = clamp((xy + field.gradient * offsets.x + field.lens) / viewport, u.valid.xy, u.valid.zw);
      let green_uv = clamp((xy + field.gradient * offsets.y + field.lens) / viewport, u.valid.xy, u.valid.zw);
      let blue_uv = clamp((xy + field.gradient * offsets.z + field.lens) / viewport, u.valid.xy, u.valid.zw);
      let transmitted = glass_tone(sample_blur_rgb(red_uv, green_uv, blue_uv, field.optics.x), field.tone);
      let normal = normalize(vec3f(field.gradient * shift.w, slope.w));
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
      result = vec4f(reflected + vec3f(highlight * u.params.z), field.colored.a * coverage);
    }
  }
  var clip_coverage = 0.0;
${each(count, i => `  {
    let clip = u.members[${i}].clip;
    let outside = max(max(clip.x - xy.x, xy.x - clip.z), max(clip.y - xy.y, xy.y - clip.w));
    clip_coverage = max(clip_coverage, 1.0 - smoothstep(-0.5, 0.5, outside));
  }`)}
  return vec4f(result.rgb, result.a * clip_coverage);
}
`
}
