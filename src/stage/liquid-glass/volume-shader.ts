import type { CodeNode } from 'three/webgpu'
import { wgslFn } from 'three/tsl'

/** 为指定数量的圆角实体生成距离场和光线求交函数。 */
export function createVolumeFunctions(count: number) {
  const declarations = Array.from({ length: count }, (_, i) => `b${i}: vec4<f32>, r${i}: vec4<f32>, d${i}: vec4<f32>, c${i}: vec4<f32>`).join(', ')
  const names = Array.from({ length: count }, (_, i) => `b${i}, r${i}, d${i}, c${i}`).join(', ')
  const shape = wgslFn(`
    fn glass_solid(p: vec3<f32>, b: vec4<f32>, radii: vec4<f32>, depth: vec4<f32>, clip: vec4<f32>) -> f32 {
      let local = p.xy - b.xy;
      let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), min(b.z, b.w));
      let q = abs(local) - b.zw + radius;
      let planar = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
      let bevel = min(depth.x * 0.9, min(b.z, b.w) * 0.65);
      let cross = vec2<f32>(planar + bevel, abs(p.z - depth.y - depth.x) - depth.x + bevel);
      let solid = length(max(cross, vec2<f32>(0.0))) + min(max(cross.x, cross.y), 0.0) - bevel;
      let clipped = max(max(clip.x - p.x, p.x - clip.z), max(clip.y - p.y, p.y - clip.w));
      return max(solid, clipped);
    }
  `)
  const distance = wgslFn(`
    fn glass_distance_${count}(p: vec3<f32>, ${declarations}) -> f32 {
      var distance = glass_solid(p, b0, r0, d0, c0);
      var fusion = d0.z;
      ${Array.from({ length: count - 1 }, (_, j) => {
        const i = j + 1
        return `{
          let other = glass_solid(p, b${i}, r${i}, d${i}, c${i});
          let k = max(min(fusion, d${i}.z) * 2.0, 0.001);
          let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
          distance = mix(other, distance, h) - k * h * (1.0 - h);
          fusion = max(fusion, d${i}.z);
        }`
      }).join('\n')}
      return distance;
    }
  `, [shape as unknown as CodeNode])
  // 外观与几何使用同一个平滑合并权重，过渡区域会随三维连接处移动。
  const valueDeclarations = Array.from({ length: count }, (_, i) => `v${i}: vec4<f32>`).join(', ')
  const blend = wgslFn(`
    fn glass_blend_${count}(p: vec3<f32>, ${declarations}, ${valueDeclarations}) -> vec4<f32> {
      var distance = glass_solid(p, b0, r0, d0, c0);
      var fusion = d0.z;
      var value = v0;
      ${Array.from({ length: count - 1 }, (_, j) => {
        const i = j + 1
        return `{
          let other = glass_solid(p, b${i}, r${i}, d${i}, c${i});
          let k = max(min(fusion, d${i}.z) * 2.0, 0.001);
          let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
          value = mix(v${i}, value, h);
          distance = mix(other, distance, h) - k * h * (1.0 - h);
          fusion = max(fusion, d${i}.z);
        }`
      }).join('\n')}
      return value;
    }
  `, [shape as unknown as CodeNode])
  const projection = wgslFn(`
    fn glass_projection_${count}(xy: vec2<f32>, ${declarations}) -> f32 {
      var distance = glass_solid(vec3<f32>(xy, d0.y + d0.x), b0, r0, d0, c0);
      var fusion = d0.z;
      ${Array.from({ length: count - 1 }, (_, j) => {
        const i = j + 1
        return `{
          let other = glass_solid(vec3<f32>(xy, d${i}.y + d${i}.x), b${i}, r${i}, d${i}, c${i});
          let k = max(min(fusion, d${i}.z) * 2.0, 0.001);
          let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
          distance = mix(other, distance, h) - k * h * (1.0 - h);
          fusion = max(fusion, d${i}.z);
        }`
      }).join('\n')}
      return distance;
    }
  `, [shape as unknown as CodeNode])
  const normal = wgslFn(`
    fn glass_normal_${count}(p: vec3<f32>, ${declarations}) -> vec3<f32> {
      let e = 0.2;
      let x = glass_distance_${count}(p + vec3<f32>(e, 0.0, 0.0), ${names}) - glass_distance_${count}(p - vec3<f32>(e, 0.0, 0.0), ${names});
      let y = glass_distance_${count}(p + vec3<f32>(0.0, e, 0.0), ${names}) - glass_distance_${count}(p - vec3<f32>(0.0, e, 0.0), ${names});
      let z = glass_distance_${count}(p + vec3<f32>(0.0, 0.0, e), ${names}) - glass_distance_${count}(p - vec3<f32>(0.0, 0.0, e), ${names});
      return normalize(vec3<f32>(x, y, z) + vec3<f32>(0.0, 0.0, 0.00001));
    }
  `, [distance as unknown as CodeNode])
  const entry = wgslFn(`
    fn glass_entry_${count}(xy: vec2<f32>, ceiling: f32, ${declarations}) -> vec4<f32> {
      var p = vec3<f32>(xy, ceiling);
      for (var i = 0; i < 48; i++) {
        let d = glass_distance_${count}(p, ${names});
        if (d < 0.06) { return vec4<f32>(p, 1.0); }
        p.z -= max(d * 0.85, 0.1);
        if (p.z < 0.0) { break; }
      }
      return vec4<f32>(p, 0.0);
    }
  `, [distance as unknown as CodeNode])
  const exit = wgslFn(`
    fn glass_exit_${count}(entry: vec3<f32>, normal: vec3<f32>, ior: f32, ${declarations}) -> vec4<f32> {
      var direction = refract(vec3<f32>(0.0, 0.0, -1.0), normal, 1.0 / ior);
      var p = entry + direction * 0.4;
      var path = 0.4;
      var bounced = false;
      for (var i = 0; i < 48; i++) {
        let d = glass_distance_${count}(p, ${names});
        if (d > -0.10) {
          let outward = glass_normal_${count}(p, ${names});
          let outgoing = refract(direction, -outward, ior);
          if (dot(outgoing, outgoing) > 0.01) {
            let travel = max(p.z, 0.0) / max(-outgoing.z, 0.02);
            let background = p.xy + outgoing.xy * min(travel, 800.0);
            return vec4<f32>(background, path, select(0.0, 1.0, outgoing.z < -0.02));
          }
          if (bounced) { break; }
          direction = reflect(direction, outward);
          p += direction * 0.5;
          bounced = true;
        } else {
          let step = max(-d * 0.85, 0.12);
          p += direction * step;
          path += step;
        }
      }
      return vec4<f32>(p.xy, path, 0.0);
    }
  `, [distance as unknown as CodeNode, normal as unknown as CodeNode])
  return {
    entry,
    normal,
    exit,
    projection,
    blend,
  }
}
