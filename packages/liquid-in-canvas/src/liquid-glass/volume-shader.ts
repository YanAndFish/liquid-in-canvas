import type { StageGpu } from '../gpu'
import { BLEND_NORMAL, PipelineTable, shaderPrelude, SLOT_CANVAS, SLOT_TARGET, TARGET_FORMAT, wgslFloat } from '../gpu'
import { CORNER_EASE, CORNER_REACH, CORNER_SQUARE } from './contour'
import { BLUR_SIGMAS } from './gaussian'
import { DISPERSION_SPREAD } from './optics-lut'
import { createFieldBakeShader, FIELD_FORMATS, FIELD_TARGETS } from './volume-field-shader'
import { createHybridVolumeShader } from './volume-hybrid-shader'
import { createProfileVolumeShader } from './volume-profile-shader'

export const VOLUME_GROUP_FLOATS = 16
export const VOLUME_MEMBER_FLOATS = 36
export const VOLUME_TEXTURES = 1 + BLUR_SIGMAS.length

export const REFLECTION_VARIANCE = 64

export const CORNER_MARGIN = 0.5

export function each(count: number, body: (i: number) => string, from = 0): string {
  return Array.from({ length: count - from }, (_, j) => body(j + from)).join('\n')
}

function memberOrder(count: number, name: string, key: (i: number) => string): string {
  const keys = each(count, i => `  let t${i} = ${key(i)};`)
  const ranks = each(count, (i) => {
    const before = Array.from({ length: count }, (_, j) => j)
      .filter(j => j !== i)
      .map((j) => {
        const op = j < i
          ? '<='
          : '<'
        return `select(0, 1, t${j} ${op} t${i})`
      })
    const rank = before.length > 0
      ? before.join(' + ')
      : '0'
    return `  order[${rank}] = ${i};`
  })
  return /* wgsl */`
fn ${name}() -> array<i32, ${count}> {
  var order: array<i32, ${count}>;
${keys}
${ranks}
  return order;
}`
}

function fusionOrder(count: number): string {
  return memberOrder(count, 'fusion_order', i => `u.members[${i}].depth.y + 2.0 * u.members[${i}].depth.x`)
}

function smoothOrder(count: number): string {
  return memberOrder(count, 'smooth_order', i => `-u.members[${i}].depth.z`)
}

export function gradientArray(count: number, prefix: string): string {
  if (count === 1)
    return ''
  return `  var grads = array<vec2f, ${count}>(${Array.from({ length: count }, (_, i) => `${prefix}${i}.yz`).join(', ')});`
}

export function fuseDominance(count: number, first: string, blend: string, gradients = false): string {
  if (count === 1) {
    return /* wgsl */`  {
    let m = u.members[0];
${first}
  }`
  }
  return /* wgsl */`  {
    var order = fusion_order();
    var dist = array<f32, ${count}>(${each(count, i => `d${i}`).split('\n').join(', ')});
    var reach = 0.0;
    {
      let m = u.members[order[0]];
${first}
      reach = m.depth.z;
    }
    for (var r = 1; r < ${count}; r++) {
      let index = order[r];
      let m = u.members[index];
      let ramp = fusion_ramp(dist[index], min(m.depth.z, reach) * (1.0 + m.extra.w));${gradients ? '\n      let falloff = -ramp.y * grads[index];' : ''}
${blend}
      reach = max(reach, m.depth.z);
    }
  }`
}

export function blurSampler(name: string, coords: readonly string[]): string {
  const pick = (texture: string): string => coords.length === 1
    ? `textureSampleLevel(${texture}, samp, ${coords[0]}, 0.0).rgb`
    : `vec3f(textureSampleLevel(${texture}, samp, ${coords[0]}, 0.0).r, textureSampleLevel(${texture}, samp, ${coords[1]}, 0.0).g, textureSampleLevel(${texture}, samp, ${coords[2]}, 0.0).b)`
  const weights = BLUR_SIGMAS.map((sigma, i) => {
    const previous = BLUR_SIGMAS[i - 1] ?? 0
    return `  let w${i} = clamp((variance - ${wgslFloat(previous * previous)}) / ${wgslFloat(sigma * sigma - previous * previous)}, 0.0, 1.0);`
  })
  const levels = BLUR_SIGMAS.map((_, i) => {
    const needed = i + 1 < BLUR_SIGMAS.length
      ? `w${i} > 0.0 && w${i + 1} < 1.0`
      : `w${i} > 0.0`
    return `  if (${needed}) { sampled = mix(sampled, ${pick(`blur${i}`)}, w${i}); }`
  })
  return /* wgsl */`
fn ${name}(${coords.map(coord => `${coord}: vec2f`).join(', ')}, variance: f32) -> vec3f {
${weights.join('\n')}
  var sampled = vec3f(0.0);
  if (w0 < 1.0) { sampled = ${pick('source')}; }
${levels.join('\n')}
  return sampled;
}
`
}

export function volumeCommon(count: number): string {
  return /* wgsl */`${shaderPrelude(`
  params: vec4f,
  shadow: vec4f,
  valid: vec4f,
  field: vec4f,
  members: array<Member, ${count}>,`, /* wgsl */`
struct Member {
  box: vec4f,
  radius: vec4f,
  depth: vec4f,
  clip: vec4f,
  appearance: vec4f,
  color: vec4f,
  profile: vec4f,
  extra: vec4f,
  refraction: vec4f,
}`)}
@group(1) @binding(0) var source: texture_2d<f32>;
${BLUR_SIGMAS.map((_, i) => `@group(1) @binding(${i + 1}) var blur${i}: texture_2d<f32>;`).join('\n')}

fn glass_rounding(local: vec2f, m: Member) -> vec4f {
  let radii = m.radius;
  let narrow = min(m.box.z, m.box.w);
  let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), narrow);
  let bevel = min(m.profile.x, narrow);
  let room = min(bevel - radius, narrow - bevel);
  let reach = clamp(bevel * ${wgslFloat(CORNER_REACH)} - radius, 0.0, narrow - radius);
  return vec4f(radius, reach, max(min(radius, room), 0.0), bevel);
}

fn glass_contour(xy: vec2f, m: Member) -> vec3f {
  let b = m.box;
  let local = xy - b.xy;
  let corner = glass_rounding(local, m);
  let radius = corner.x;
  let reach = corner.y;
  let w = abs(local) - b.zw + radius;
  let side = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  let q = max(w, vec2f(0.0));
  let l = length(q);
  let g = max(w.x, w.y);
  let exact = select(g, l, g > 0.0) - radius;
  let outward = select(select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), w.x > w.y), q / max(l, 0.00001), g > 0.0);
  let lifted = w + reach;
  if (reach <= 0.0 || exact >= 0.0 || lifted.x <= 0.0 || lifted.y <= 0.0) {
    return vec3f(exact, outward * side);
  }
  let power = 2.0 + 2.0 * min(reach / max(radius * ${wgslFloat(CORNER_SQUARE)}, 0.001), 1.0);
  let scale = max(lifted.x, lifted.y);
  let unit = lifted / scale;
  let sum = dot(pow(unit, vec2f(power)), vec2f(1.0));
  let rounded = scale * pow(sum, 1.0 / power) - radius - reach;
  let toward = pow(unit, vec2f(power - 1.0)) / pow(sum, (power - 1.0) / power);
  let ease = corner.w * ${wgslFloat(CORNER_EASE)};
  let t = min(-exact / ease, 1.0);
  let weight = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  let slope = 30.0 * t * t * (1.0 - t) * (1.0 - t) / ease;
  let normal = mix(outward, toward, weight) - (rounded - exact) * slope * outward;
  return vec3f(mix(exact, rounded, weight), normal / max(length(normal), 0.00001) * side);
}

fn glass_contour_wide(xy: vec2f, m: Member) -> vec3f {
  let b = m.box;
  let local = xy - b.xy;
  let corner = glass_rounding(local, m);
  let radius = corner.x;
  let rounding = corner.z;
  let w = abs(local) - b.zw + radius;
  let side = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  let q = max(w, vec2f(0.0));
  let l = length(q);
  let g = max(w.x, w.y);
  let exact = select(g, l, g > 0.0) - radius;
  let shift = radius - rounding;
  if (rounding <= 0.0 || exact >= -shift) {
    let inner = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), w.x > w.y);
    return vec3f(exact, select(inner, q / max(l, 0.00001), g > 0.0) * side);
  }
  let e = w.x - w.y;
  let deeper = select(rounding - g, 0.5 * (sqrt(max(2.0 * rounding * rounding - e * e, 0.0)) - w.x - w.y), abs(e) < rounding);
  let normal = max(w + deeper, vec2f(0.0));
  return vec3f(-(shift + deeper), normal / max(length(normal), 0.00001) * side);
}

fn glass_outline(xy: vec2f, m: Member) -> f32 {
  return glass_contour(xy, m).x;
}

fn glass_corner(xy: vec2f, m: Member, lateral: f32) -> bool {
  let local = xy - m.box.xy;
  let corner = glass_rounding(local, m);
  if (corner.x >= min(m.profile.x, min(m.box.z, m.box.w)) - ${wgslFloat(CORNER_MARGIN)}) { return false; }
  let w = abs(local) - m.box.zw + corner.x;
  let reach = max(select(0.0, corner.x + corner.y, corner.y > 0.0), corner.z) + lateral;
  if (w.x >= 0.0 && w.y >= 0.0) { return length(w) < reach; }
  return abs(w.x - w.y) < reach;
}
${fusionOrder(count)}
${smoothOrder(count)}
fn fusion_ramp(distance: f32, reach: f32) -> vec2f {
  let width = max(reach, 0.001);
  let t = clamp(distance / width, 0.0, 1.0);
  return vec2f(1.0 - t * t * t * (t * (t * 6.0 - 15.0) + 10.0), 30.0 * t * t * (1.0 - t) * (1.0 - t) / width);
}

fn glass_lens(xy: vec2f, m: Member) -> vec2f {
  let local = xy - m.box.xy;
  let reach = max(min(m.box.z, m.box.w), 0.001);
  let inward = clamp((m.box.zw - abs(local)) / reach, vec2f(0.0), vec2f(1.0));
  let slope = 1.0 - inward;
  let dome = 1.0 - slope * slope;
  return -m.depth.w * reach * sign(local) * vec2f(slope.x * dome.y, slope.y * dome.x);
}

fn glass_clip(xy: vec2f, clip: vec4f) -> f32 {
  return max(max(clip.x - xy.x, xy.x - clip.z), max(clip.y - xy.y, xy.y - clip.w));
}

fn glass_tone(color: vec3f, tone: vec2f) -> vec3f {
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(luminance), color, tone.x) * tone.y, vec3f(0.0));
}

fn shadow_strength(at: vec2f, variance: f32) -> f32 {
  let backdrop = sample_blur(clamp(at, u.valid.xy, u.valid.zw), variance + ${wgslFloat(REFLECTION_VARIANCE)});
  let luminance = dot(backdrop, vec3f(0.2126, 0.7152, 0.0722));
  return mix(0.35, 1.0, smoothstep(0.2, 0.8, luminance));
}
${blurSampler('sample_blur', ['at'])}${blurSampler('sample_blur_rgb', ['red', 'green', 'blue'])}`
}

export function clipCoverage(count: number): string {
  return /* wgsl */`  var clip_coverage = 0.0;
${each(count, i => `  {
    let outside = glass_clip(xy, u.members[${i}].clip);
    clip_coverage = max(clip_coverage, 1.0 - smoothstep(-0.5, 0.5, outside));
  }`)}`
}

export function fuseOutlines(count: number, first: string, extra: string): string {
  if (count === 1) {
    return /* wgsl */`  {
    let index = 0;
    let m = u.members[0];
    distance = d0;
${first}
  }`
  }
  return /* wgsl */`  {
    var outline_order = smooth_order();
    var outlines = array<f32, ${count}>(${each(count, i => `d${i}`).split('\n').join(', ')});
    {
      let index = outline_order[0];
      let m = u.members[index];
      distance = outlines[index];
${first}
    }
    for (var r = 1; r < ${count}; r++) {
      let index = outline_order[r];
      let m = u.members[index];
      let other = outlines[index];
      let k = max(m.depth.z * 2.0, 0.001);
      let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
${extra}
      distance = mix(other, distance, h) - k * h * (1.0 - h);
    }
  }`
}

function glassBody(count: number): string {
  return /* wgsl */`fn glass_body(xy: vec2f) -> Body {
  var b: Body;
${each(count, i => `  let d${i} = glass_outline(xy, u.members[${i}]);
  let c${i} = glass_clip(xy, u.members[${i}].clip);`)}
  var distance: f32;
  var clips = array<f32, ${count}>(${each(count, i => `c${i}`).split('\n').join(', ')});
${fuseOutlines(count, `    b.clip = max(clips[index], -m.depth.x - 1.0);`, `    b.clip = mix(max(clips[index], -m.depth.x - 1.0), b.clip, h);`)}
  b.owner = 0;
  b.nearest = max(d0, c0);
  b.second = 1000000.0;
${each(count, i => `  {
    let apart = max(d${i}, c${i});
    if (apart < b.nearest) {
      b.second = b.nearest;
      b.nearest = apart;
      b.owner = ${i};
    } else {
      b.second = min(b.second, apart);
    }
  }`, 1)}
  b.planar = distance;
  var top_slope = 0.0;
  var bottom_slope = 0.0;
  var bevel_slope = 0.0;
${fuseDominance(count, `      b.middle = m.depth.y + m.depth.x;
      b.half_depth = m.depth.x;
      b.bevel = vec2f(min(m.profile.x, min(m.box.z, m.box.w)), m.profile.y);
      b.shape = m.profile.zw;`, `      let w = ramp.x;
      let bevel = vec2f(min(m.profile.x, min(m.box.z, m.box.w)), m.profile.y);
      top_slope = (1.0 - w) * top_slope + abs(m.depth.y + 2.0 * m.depth.x - b.middle - b.half_depth) * ramp.y;
      bottom_slope = (1.0 - w) * bottom_slope + abs(m.depth.y - b.middle + b.half_depth) * ramp.y;
      bevel_slope = (1.0 - w) * bevel_slope + max(abs(bevel.x - b.bevel.x), abs(bevel.y - b.bevel.y)) * ramp.y;
      b.middle = mix(b.middle, m.depth.y + m.depth.x, w);
      b.half_depth = mix(b.half_depth, m.depth.x, w);
      b.bevel = mix(b.bevel, bevel, w);
      b.shape = mix(b.shape, m.profile.zw, w);`)}
  b.lipschitz = 1.0 + max(top_slope, bottom_slope) + bevel_slope;
  return b;
}`
}

export function raymarchOptics(count: number): string {
  return /* wgsl */`
struct Body {
  planar: f32,
  clip: f32,
  middle: f32,
  half_depth: f32,
  bevel: vec2f,
  shape: vec2f,
  lipschitz: f32,
  owner: i32,
  nearest: f32,
  second: f32,
}

${glassBody(count)}

fn glass_section(planar: f32, height: f32, b: Body) -> f32 {
  let scale = select(b.shape.y, 1.0, height > 0.0);
  let bevel = max(b.bevel * scale, vec2f(0.5));
  let unit = vec2f(planar + bevel.x, abs(height) - b.half_depth + bevel.y) / bevel;
  let positive = max(unit, vec2f(0.0));
  let power = b.shape.x;
  let rounded = pow(pow(positive.x, power) + pow(positive.y, power), 1.0 / power);
  let lipschitz = min(1.0, exp2(0.5 - 1.0 / power));
  let curved = (rounded + min(max(unit.x, unit.y), 0.0) - 1.0) * min(bevel.x, bevel.y) * lipschitz;
  return max(curved, max(planar, abs(height) - b.half_depth));
}

fn glass_distance(p: vec3f) -> f32 {
  let b = glass_body(p.xy);
  return max(glass_section(b.planar, p.z - b.middle, b), b.clip);
}

fn glass_march(p: vec3f, direction: vec3f) -> vec2f {
  let b = glass_body(p.xy);
  let d = max(glass_section(b.planar, p.z - b.middle, b), b.clip);
  return vec2f(d, d / (abs(direction.z) + b.lipschitz * length(direction.xy)));
}

fn glass_projection(xy: vec2f) -> f32 {
  let b = glass_body(xy);
  return max(glass_section(b.planar, 0.0, b), b.clip);
}

fn glass_normal(p: vec3f) -> vec3f {
  let e = 0.08;
  let x = glass_distance(p + vec3f(e, 0.0, 0.0)) - glass_distance(p - vec3f(e, 0.0, 0.0));
  let y = glass_distance(p + vec3f(0.0, e, 0.0)) - glass_distance(p - vec3f(0.0, e, 0.0));
  let z = glass_distance(p + vec3f(0.0, 0.0, e)) - glass_distance(p - vec3f(0.0, 0.0, e));
  return normalize(vec3f(x, y, z) + vec3f(0.0, 0.0, 0.00001));
}

fn glass_entry(xy: vec2f) -> vec4f {
  var p = vec3f(xy, u.params.x);
  for (var i = 0; i < 64; i++) {
    let d = glass_distance(p);
    if (d < 0.02) { return vec4f(p, 1.0); }
    p.z -= max(d * 0.85, 0.025);
    if (p.z < 0.0) { break; }
  }
  return vec4f(p, 0.0);
}

fn glass_exit(entry: vec3f, normal: vec3f, ior: f32) -> vec4f {
  var direction = refract(vec3f(0.0, 0.0, -1.0), normal, 1.0 / ior);
  var p = entry + direction * 0.12;
  var path = 0.12;
  var bounced = false;
  for (var i = 0; i < 64; i++) {
    let d = glass_march(p, direction);
    if (d.x > -0.025) {
      let outward = glass_normal(p);
      let outgoing = refract(direction, -outward, ior);
      if (dot(outgoing, outgoing) > 0.01) {
        let travel = max(p.z, 0.0) / max(-outgoing.z, 0.02);
        let background = p.xy + outgoing.xy * min(travel, 800.0);
        return vec4f(background, path, smoothstep(0.02, 0.14, -outgoing.z));
      }
      if (bounced) { break; }
      direction = reflect(direction, outward);
      p += direction * 0.5;
      bounced = true;
    } else {
      let step = max(-d.y * 0.85, 0.035);
      p += direction * step;
      path += step;
    }
  }
  return vec4f(p.xy, path, 0.0);
}
struct Material {
  optics: vec4f,
  ior: f32,
  colored: vec4f,
  color: vec3f,
  lens: vec2f,
  tone: vec2f,
}

fn glass_material(p: vec3f) -> Material {
  let xy = p.xy;
${each(count, i => `  let d${i} = glass_outline(xy, u.members[${i}]);`)}
  var optics: vec4f;
  var ior: f32;
  var colored: vec4f;
  var lens: vec2f;
  var tone: vec2f;
${fuseDominance(count, `      optics = m.appearance;
      ior = m.refraction.x;
      colored = m.color;
      lens = glass_lens(xy, m);
      tone = m.extra.yz;`, `      optics = mix(optics, m.appearance, ramp.x);
      ior = mix(ior, m.refraction.x, ramp.x);
      colored = mix(colored, m.color, ramp.x);
      lens = mix(lens, glass_lens(xy, m), ramp.x);
      tone = mix(tone, m.extra.yz, ramp.x);`)}
  var material: Material;
  material.optics = optics;
  material.ior = ior;
  material.colored = colored;
  material.color = colored.rgb / max(optics.z, 0.0001);
  material.lens = lens;
  material.tone = tone;
  return material;
}

struct Paths {
  height: f32,
  normal: vec3f,
  red: vec3f,
  green: vec3f,
  blue: vec3f,
}

fn glass_paths(entry: vec3f, ior: f32, spread: f32) -> Paths {
  var paths: Paths;
  paths.height = entry.z;
  paths.normal = glass_normal(entry);
  let green = glass_exit(entry, paths.normal, ior);
  var red = green;
  var blue = green;
  if (spread > 0.00001) {
    red = glass_exit(entry, paths.normal, ior - spread);
    blue = glass_exit(entry, paths.normal, ior + spread);
  }
  paths.red = red.xyw;
  paths.green = green.xyw;
  paths.blue = blue.xyw;
  return paths;
}

fn glass_shade(screen_uv: vec2f, material: Material, paths: Paths) -> vec4f {
  let viewport = u.screen.zw;
  let normal = paths.normal;
  let red_uv = clamp((paths.red.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let green_uv = clamp((paths.green.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let blue_uv = clamp((paths.blue.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let transmitted = glass_tone(sample_blur_rgb(red_uv, green_uv, blue_uv, material.optics.x), material.tone);
  let reflection = reflect(vec3f(0.0, 0.0, -1.0), normal);
  let environment_uv = clamp(screen_uv + reflection.xy * 48.0 / viewport, u.valid.xy, u.valid.zw);
  let environment = sample_blur(environment_uv, material.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
  let fresnel = 0.034 + pow(1.0 - clamp(normal.z, 0.0, 1.0), 5.0) * 0.966;
  let tinted = mix(transmitted, material.color, material.optics.z);
  let valid = vec3f(paths.red.z, paths.green.z, paths.blue.z);
  var refracted = tinted;
  if (min(valid.x, min(valid.y, valid.z)) < 1.0) {
    let local_environment = glass_tone(sample_blur(screen_uv, material.optics.x), material.tone);
    refracted = mix(mix(local_environment, material.color, material.optics.z), tinted, valid);
  }
  let reflected = mix(refracted, environment, clamp(fresnel * material.optics.w, 0.0, 1.0));
  let light = pow(max(dot(normal, normalize(vec3f(-0.45, -0.6, 0.66))), 0.0), 32.0);
  let edge = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);
  let highlight = (light * 0.035 * edge + edge * 0.035) * material.optics.w;
  return vec4f(reflected + vec3f(highlight * u.params.z), material.colored.a);
}

fn glass_trace(xy: vec2f, screen_uv: vec2f) -> vec4f {
  let entry = glass_entry(xy);
  if (entry.w <= 0.5) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let material = glass_material(entry.xyz);
  return glass_shade(screen_uv, material, glass_paths(entry.xyz, material.ior, material.optics.y * ${wgslFloat(DISPERSION_SPREAD)}));
}
`
}

export function createVolumeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}
fn glass_slab(xy: vec2f) -> f32 {
  var top = -1.0;
  var inside = 0;
  var away = 0;
${each(count, i => `  {
    let m = u.members[${i}];
    let planar = glass_outline(xy, m);
    let clipped = glass_clip(xy, m.clip);
    let bevel = max(min(m.profile.x, min(m.box.z, m.box.w)), 0.5);
    if (planar + bevel < -0.5 && clipped < -1.0) {
      inside += 1;
      top = m.depth.y + m.depth.x * 2.0;
    } else if (max(planar, clipped) >= u.params.y) {
      away += 1;
    }
  }`)}
  if (inside == 1 && away == ${count - 1}) { return top; }
  return -1.0;
}

@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
  let outline = glass_projection(xy);
  let distance = glass_projection(xy - vec2f(0.0, 4.0));
  var shadow_alpha = exp(max(distance, 0.0) / max(u.shadow.y, 1.0) * -4.0) * u.shadow.x;
  if (outline > 0.0 && shadow_alpha > 0.002) {
    shadow_alpha *= shadow_strength(screen_uv, u.members[0].appearance.x);
  }
  var result = vec4f(0.0, 0.0, 0.0, shadow_alpha);
  let coverage = 1.0 - smoothstep(-0.7, 0.3, outline);
  if (outline < 0.02) {
    let top = glass_slab(xy);
    if (top >= 0.0) {
      let material = glass_material(vec3f(xy, top));
      let here = clamp(screen_uv, u.valid.xy, u.valid.zw);
      let through = clamp(screen_uv + material.lens / viewport, u.valid.xy, u.valid.zw);
      let transmitted = glass_tone(sample_blur(through, material.optics.x), material.tone);
      let environment = sample_blur(here, material.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
      let reflected = mix(mix(transmitted, material.color, material.optics.z), environment, clamp(material.optics.w * 0.034, 0.0, 1.0));
      result = vec4f(reflected, material.colored.a * coverage);
    } else {
      let traced = glass_trace(xy, screen_uv);
      if (traced.a >= 0.0) {
        result = vec4f(traced.rgb, traced.a * coverage);
      }
    }
  }
${clipCoverage(count)}
  return vec4f(result.rgb, result.a * clip_coverage);
}
`
}

export interface VolumeTextures {
  generation: number
  group: GPUBindGroup
}

export function fieldUnfilterable(): number {
  let mask = 0
  for (let i = 0; i < FIELD_FORMATS.length; i++) {
    if (FIELD_FORMATS[i] === 'rgba32float')
      mask |= 1 << (VOLUME_TEXTURES + 1 + i)
  }
  return mask
}

export function bindVolumeTextures(
  gpu: StageGpu,
  source: GPUTextureView,
  blurs: readonly GPUTextureView[],
  generation: number,
  lut: GPUTextureView | null = null,
  fields: readonly GPUTextureView[] = [],
): VolumeTextures {
  return {
    generation,
    group: gpu.textureGroupOf(lut
      ? [
          source,
          ...blurs,
          lut,
          ...fields,
        ]
      : [source, ...blurs], fields.length > 0
      ? fieldUnfilterable()
      : 0),
  }
}

export type VolumePipelineKind = 'raymarch' | 'profile' | 'hybrid' | 'field'

function volumeShaderOf(kind: VolumePipelineKind, count: number): string {
  if (kind === 'profile')
    return createProfileVolumeShader(count)
  if (kind === 'hybrid' || kind === 'field')
    return createHybridVolumeShader(count, kind === 'field')
  return createVolumeShader(count)
}

function volumeTexturesOf(kind: VolumePipelineKind): number {
  if (kind === 'raymarch')
    return VOLUME_TEXTURES
  return kind === 'field'
    ? VOLUME_TEXTURES + 1 + FIELD_TARGETS
    : VOLUME_TEXTURES + 1
}

export function createVolumePipelines(gpu: StageGpu, kind: VolumePipelineKind = 'raymarch'): PipelineTable[] {
  const prefix = kind === 'raymarch'
    ? 'volume'
    : `volume-${kind}`
  return [SLOT_CANVAS, SLOT_TARGET].map(slot => new PipelineTable(gpu, `${prefix}:${slot}`, count => ({
    code: volumeShaderOf(kind, count),
    entry: 'volume',
    textures: volumeTexturesOf(kind),
    unfilterable: kind === 'field'
      ? fieldUnfilterable()
      : 0,
    format: gpu.formatOf(slot),
    blend: BLEND_NORMAL,
  })))
}

export function createFieldBakePipelines(gpu: StageGpu): PipelineTable {
  return new PipelineTable(gpu, 'volume-bake', count => ({
    code: createFieldBakeShader(count),
    entry: 'bake',
    textures: VOLUME_TEXTURES + 1,
    format: TARGET_FORMAT,
    formats: FIELD_FORMATS,
  }))
}
