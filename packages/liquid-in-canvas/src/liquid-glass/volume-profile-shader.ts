import { wgslFloat } from '../gpu'
import { LUT_ROWS_PER_PROFILE, LUT_SAMPLES, MAX_TRAVEL } from './optics-lut'
import { clipCoverage, each, fuseDominance, fuseOutlines, gradientArray, REFLECTION_VARIANCE, VOLUME_TEXTURES, volumeCommon } from './volume-shader'

export function profileOptics(): string {
  return /* wgsl */`
@group(1) @binding(${VOLUME_TEXTURES}) var lut: texture_2d<f32>;

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
  stretch: f32,
  top_slope: vec2f,
  bottom_slope: vec2f,
  shape: vec2f,
}

fn member_bevel(m: Member) -> f32 {
  return max(min(m.profile.x, min(m.box.z, m.box.w)), 0.5);
}

fn lut_at(field: Field, texel_row: f32) -> vec4f {
  let inset = clamp(-field.distance / field.bevel, 0.0, 1.0);
  let size = vec2f(textureDimensions(lut));
  let x = (sqrt(inset) * ${wgslFloat(LUT_SAMPLES - 1)} + 0.5) / size.x;
  return textureSampleLevel(lut, samp, vec2f(x, (field.row * ${wgslFloat(LUT_ROWS_PER_PROFILE)} + texel_row + 0.5) / size.y), 0.0);
}

fn glass_lookup(field: Field, xy: vec2f, screen_uv: vec2f) -> vec4f {
  let viewport = u.screen.zw;
  let shift = lut_at(field, 0.0);
  let slope = lut_at(field, 1.0);
  let validity = lut_at(field, 2.0);
  if (validity.w <= 0.5) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let material_color = field.colored.rgb / max(field.optics.z, 0.0001);
  let offsets = clamp((shift.xyz * field.half_depth + slope.xyz * field.elevation) * field.stretch, vec3f(-${wgslFloat(MAX_TRAVEL)}), vec3f(${wgslFloat(MAX_TRAVEL)}));
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

export function profileField(count: number): string {
  const firstGradient = count === 1
    ? 'c0.yz'
    : 'grads[index]'
  return /* wgsl */`
fn glass_field(xy: vec2f) -> Field {
${each(count, i => `  let c${i} = glass_contour_wide(xy, u.members[${i}]);
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

export function createProfileVolumeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${profileOptics()}
${profileField(count)}
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
