import type { CodeNode } from 'three/webgpu'
import { wgslFn } from 'three/tsl'

/** 为指定数量的圆角实体生成距离场和光线求交函数。 */
export function createVolumeFunctions(count: number) {
  const declarations = Array.from({ length: count }, (_, i) => `b${i}: vec4<f32>, r${i}: vec4<f32>, d${i}: vec4<f32>, c${i}: vec4<f32>`).join(', ')
  const names = Array.from({ length: count }, (_, i) => `b${i}, r${i}, d${i}, c${i}`).join(', ')
  // 三次超椭圆在平面接合处的曲率趋于零，折射压缩不会在固定内圈突然开始。
  const outline = wgslFn(`
    fn glass_outline(xy: vec2<f32>, b: vec4<f32>, radii: vec4<f32>) -> f32 {
      let local = xy - b.xy;
      let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), min(b.z, b.w));
      let q = abs(local) - b.zw + radius;
      return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    }
  `)
  const shape = wgslFn(`
    fn glass_solid(p: vec3<f32>, b: vec4<f32>, radii: vec4<f32>, depth: vec4<f32>, clip: vec4<f32>) -> f32 {
      let planar = glass_outline(p.xy, b, radii);
      let bevel = min(depth.x * 0.68, min(b.z, b.w) * 0.5);
      let cross = vec2<f32>(planar + bevel, abs(p.z - depth.y - depth.x) - depth.x + bevel);
      let positive = max(cross, vec2<f32>(0.0));
      let rounded = pow(positive.x * positive.x * positive.x + positive.y * positive.y * positive.y, 1.0 / 3.0);
      let solid = rounded + min(max(cross.x, cross.y), 0.0) - bevel;
      let clipped = max(max(clip.x - p.x, p.x - clip.z), max(clip.y - p.y, p.y - clip.w));
      return max(solid, clipped);
    }
  `, [outline as unknown as CodeNode])
  /**
   * 判断像素是否落在某个成员的平顶区域，且其余成员远到不参与平滑合并。
   *
   * 平顶区域内实体退化为等厚平板：法线垂直于屏幕，三条光路都沿直线穿过，出射位置就是像素本身。
   * 满足条件时返回平板顶面高度，着色器据此跳过求交；否则返回 -1。
   * `reach` 是其余成员必须保持的最小距离，取所有平滑合并半径之和的上界，保证与逐步求交的结果一致。
   */
  const slab = wgslFn(`
    fn glass_slab_${count}(xy: vec2<f32>, reach: f32, ${declarations}) -> f32 {
      var top = -1.0;
      var inside = 0;
      var away = 0;
      ${Array.from({ length: count }, (_, i) => `{
        let planar = glass_outline(xy, b${i}, r${i});
        let clipped = max(max(c${i}.x - xy.x, xy.x - c${i}.z), max(c${i}.y - xy.y, xy.y - c${i}.w));
        let bevel = min(d${i}.x * 0.68, min(b${i}.z, b${i}.w) * 0.5);
        if (planar + bevel < -0.5 && clipped < -1.0) {
          inside += 1;
          top = d${i}.y + d${i}.x * 2.0;
        } else if (max(planar, clipped) >= reach) {
          away += 1;
        }
      }`).join('\n')}
      if (inside == 1 && away == ${count - 1}) { return top; }
      return -1.0;
    }
  `, [outline as unknown as CodeNode])
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
      let e = 0.08;
      let x = glass_distance_${count}(p + vec3<f32>(e, 0.0, 0.0), ${names}) - glass_distance_${count}(p - vec3<f32>(e, 0.0, 0.0), ${names});
      let y = glass_distance_${count}(p + vec3<f32>(0.0, e, 0.0), ${names}) - glass_distance_${count}(p - vec3<f32>(0.0, e, 0.0), ${names});
      let z = glass_distance_${count}(p + vec3<f32>(0.0, 0.0, e), ${names}) - glass_distance_${count}(p - vec3<f32>(0.0, 0.0, e), ${names});
      return normalize(vec3<f32>(x, y, z) + vec3<f32>(0.0, 0.0, 0.00001));
    }
  `, [distance as unknown as CodeNode])
  const entry = wgslFn(`
    fn glass_entry_${count}(xy: vec2<f32>, ceiling: f32, ${declarations}) -> vec4<f32> {
      var p = vec3<f32>(xy, ceiling);
      for (var i = 0; i < 64; i++) {
        let d = glass_distance_${count}(p, ${names});
        if (d < 0.02) { return vec4<f32>(p, 1.0); }
        p.z -= max(d * 0.85, 0.025);
        if (p.z < 0.0) { break; }
      }
      return vec4<f32>(p, 0.0);
    }
  `, [distance as unknown as CodeNode])
  const exit = wgslFn(`
    fn glass_exit_${count}(entry: vec3<f32>, normal: vec3<f32>, ior: f32, ${declarations}) -> vec4<f32> {
      var direction = refract(vec3<f32>(0.0, 0.0, -1.0), normal, 1.0 / ior);
      var p = entry + direction * 0.12;
      var path = 0.12;
      var bounced = false;
      for (var i = 0; i < 64; i++) {
        let d = glass_distance_${count}(p, ${names});
        if (d > -0.025) {
          let outward = glass_normal_${count}(p, ${names});
          let outgoing = refract(direction, -outward, ior);
          if (dot(outgoing, outgoing) > 0.01) {
            let travel = max(p.z, 0.0) / max(-outgoing.z, 0.02);
            let background = p.xy + outgoing.xy * min(travel, 800.0);
            return vec4<f32>(background, path, smoothstep(0.02, 0.14, -outgoing.z));
          }
          if (bounced) { break; }
          direction = reflect(direction, outward);
          p += direction * 0.5;
          bounced = true;
        } else {
          let step = max(-d * 0.85, 0.035);
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
    slab,
  }
}
