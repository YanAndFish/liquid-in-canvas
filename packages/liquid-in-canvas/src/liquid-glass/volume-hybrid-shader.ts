import { wgslFloat } from '../gpu'
import { FIELD_TARGETS } from './volume-field-shader'
import { profileField, profileOptics } from './volume-profile-shader'
import { clipCoverage, each, raymarchOptics, REFLECTION_VARIANCE, VOLUME_TEXTURES, volumeCommon } from './volume-shader'

export const HYBRID_REACH_SCALE = 1.1
export const HYBRID_REACH_PAD = 2
export const HYBRID_CLIP_PAD = 6

export function hybridLateral(reach: number, halfDepth: number): number {
  return reach * halfDepth * HYBRID_REACH_SCALE + HYBRID_REACH_PAD
}

export function hybridOwner(): string {
  return /* wgsl */`  let b = glass_body(xy);
  let owner = b.owner;
  let second = b.second;
  let outline = max(glass_section(b.planar, 0.0, b), b.clip);`
}

export const FIELD_FEATHER = 8

export function hybridTier(): string {
  return /* wgsl */`    let m = u.members[owner];
    let contour = glass_contour(xy, m);
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
    field.ior = m.refraction.x;
    field.tone = m.extra.yz;
    field.stretch = 1.0;
    field.top_slope = vec2f(0.0);
    field.bottom_slope = vec2f(0.0);
    field.shape = m.profile.yz;
    let on_slab = contour.x + field.bevel < -0.5 && clipped < -1.0 && second >= u.params.w;
    let lateral = lut_at(field, 3.0).x * m.depth.x * ${wgslFloat(HYBRID_REACH_SCALE)} + ${wgslFloat(HYBRID_REACH_PAD)};
    let alone = second >= u.params.w + lateral && clipped <= -(lateral + m.depth.x) && !glass_corner(xy, m, lateral);`
}

function traceTier(cached: boolean): string {
  if (!cached)
    return /* wgsl */`        shaded = glass_trace(xy, screen_uv);`
  return /* wgsl */`        let fade = field_fade(xy);
        if (fade <= 0.0) {
          shaded = glass_lookup(glass_field(xy), xy, screen_uv);
        } else {
          let texel = vec2i(floor(in.position.xy * u.field.z - u.field.xy));
          var stored = vec4f(0.0, 0.0, 0.0, -1.0);
          if (all(texel >= vec2i(0)) && all(texel < vec2i(textureDimensions(field2)))) {
            stored = textureLoad(field2, texel, 0);
          }
          if (stored.w >= 0.0) {
            let first = textureLoad(field0, texel, 0);
            let rest = textureLoad(field1, texel, 0);
            var paths: Paths;
            paths.height = stored.w;
            let green = xy + first.xy;
            paths.normal = vec3f(first.zw, sqrt(max(1.0 - dot(first.zw, first.zw), 0.0)));
            paths.red = vec3f(green + rest.xy, stored.x);
            paths.green = vec3f(green, stored.y);
            paths.blue = vec3f(green + rest.zw, stored.z);
            shaded = glass_shade(screen_uv, glass_material(vec3f(xy, stored.w)), paths);
          } else {
            shaded = glass_trace(xy, screen_uv);
          }
          if (fade < 1.0) {
            let approximate = glass_lookup(glass_field(xy), xy, screen_uv);
            if (approximate.a >= 0.0 && shaded.a >= 0.0) {
              shaded = mix(approximate, shaded, fade);
            } else if (approximate.a >= 0.0) {
              shaded = vec4f(approximate.rgb, approximate.a * (1.0 - fade));
            } else if (shaded.a >= 0.0) {
              shaded.a *= fade;
            }
          }
        }`
}

export function createHybridVolumeShader(count: number, cached = false): string {
  const fields = cached
    ? /* wgsl */`${each(FIELD_TARGETS, i => `@group(1) @binding(${VOLUME_TEXTURES + 1 + i}) var field${i}: texture_2d<f32>;`)}
${profileField(count)}
fn field_fade(xy: vec2f) -> f32 {
  let outside = max(max(u.dirty.x - xy.x, xy.x - u.dirty.z), max(u.dirty.y - xy.y, xy.y - u.dirty.w));
  let inside = 1.0 - smoothstep(${wgslFloat(-FIELD_FEATHER)}, 0.0, outside);
  return mix(u.field.w, min(u.field.w, u.shadow.z), inside);
}`
    : ''
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}${profileOptics()}${fields}
@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
${hybridOwner()}
  let distance = glass_projection(xy - vec2f(0.0, 4.0));
  var shadow_alpha = exp(max(distance, 0.0) / max(u.shadow.y, 1.0) * -4.0) * u.shadow.x;
  if (outline > 0.0 && shadow_alpha > 0.002) {
    shadow_alpha *= shadow_strength(screen_uv, u.members[0].appearance.x);
  }
  var result = vec4f(0.0, 0.0, 0.0, shadow_alpha);
  let coverage = 1.0 - smoothstep(-0.7, 0.3, outline);
  if (outline < 0.02) {
${hybridTier()}
    if (on_slab) {
      let here = clamp(screen_uv, u.valid.xy, u.valid.zw);
      let through = clamp(screen_uv + field.lens / viewport, u.valid.xy, u.valid.zw);
      let transmitted = glass_tone(sample_blur(through, m.appearance.x), field.tone);
      let environment = sample_blur(here, m.appearance.x + ${wgslFloat(REFLECTION_VARIANCE)});
      let color = m.color.rgb / max(m.appearance.z, 0.0001);
      let reflected = mix(mix(transmitted, color, m.appearance.z), environment, clamp(m.appearance.w * 0.034, 0.0, 1.0));
      result = vec4f(reflected, m.color.a * coverage);
    } else {
      var shaded = vec4f(0.0, 0.0, 0.0, -1.0);
      if (alone) {
        shaded = glass_lookup(field, xy, screen_uv);
      } else {
${traceTier(cached)}
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
