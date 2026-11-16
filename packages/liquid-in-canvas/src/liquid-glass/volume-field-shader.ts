import { wgslFloat } from '../gpu'
import { DISPERSION_SPREAD } from './optics-lut'
import { hybridOwner, hybridTier } from './volume-hybrid-shader'
import { profileOptics } from './volume-profile-shader'
import { raymarchOptics, volumeCommon } from './volume-shader'

export const FIELD_FORMATS: readonly GPUTextureFormat[] = ['rgba32float', 'rgba16float', 'rgba16float']
export const FIELD_TARGETS = FIELD_FORMATS.length
export const FIELD_TEXEL_BYTES = 16 + 8 + 8

export function createFieldBakeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}${profileOptics()}
struct FieldOutput {
  @location(0) first: vec4f,
  @location(1) rest: vec4f,
  @location(2) stored: vec4f,
}

@fragment
fn bake(in: VertexOutput) -> FieldOutput {
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
