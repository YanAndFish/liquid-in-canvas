import { shaderPrelude, wgslFloat } from '../gpu'
import { BLUR_SIGMAS } from './gaussian'

/** 体积组 uniform 中矩形与目标尺寸之后、成员之前的浮点数个数：`params` 与 `shadow`。 */
export const VOLUME_GROUP_FLOATS = 8
/** 每个成员占用的浮点数个数，对应着色器里的 `Member`。 */
export const VOLUME_MEMBER_FLOATS = 24
/** 体积着色器取样的纹理数量：背景加各级模糊。 */
export const VOLUME_TEXTURES = 1 + BLUR_SIGMAS.length

/** 反射取样在透射方差之上附加的粗糙度，单位为 CSS 像素的平方。 */
export const REFLECTION_VARIANCE = 64

/** 依次对每个成员展开一段代码。 */
function each(count: number, body: (i: number) => string, from = 0): string {
  return Array.from({ length: count - from }, (_, j) => body(j + from)).join('\n')
}

/**
 * 按方差选择高斯层的取样函数。
 *
 * 相邻两层之外的权重恒为 0 或 1，因此每次只取样真正参与插值的层。
 * 这些纹理都只有一级，显式取第 0 级可以在分支内取样而不依赖屏幕空间导数。
 * 传入一个坐标时三通道共用一次取样，传入三个坐标时按 RGB 光路分别取样。
 */
function blurSampler(name: string, coords: readonly string[]): string {
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

/**
 * 生成指定成员数量的体积着色器：圆角实体的距离场、平滑合并、光线求交与着色。
 *
 * 着色器只取决于成员数量，成员的位置与外观逐帧写入 uniform。
 * 坐标使用视口的 CSS 像素，z 轴垂直于屏幕指向观察者，背景平面在 z = 0。
 */
export function createVolumeShader(count: number): string {
  /** 按成员顺序做平滑合并；`extra` 在每一步用同一个权重混合附带的值。 */
  const fuse = (first: string, other: (i: number) => string, extra: (i: number) => string = () => ''): string => `
  var distance = ${first};
  var fusion = u.members[0].depth.z;
${each(count, i => `  {
    let other = ${other(i)};
    let k = max(min(fusion, u.members[${i}].depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
${extra(i)}
    distance = mix(other, distance, h) - k * h * (1.0 - h);
    fusion = max(fusion, u.members[${i}].depth.z);
  }`, 1)}`
  const solid = (i: number, p: string): string => `glass_solid(${p}, u.members[${i}])`

  return /* wgsl */`${shaderPrelude(`
  // 求交起点的高度、平顶捷径要求的最小间距、染色与高光的亮度比例。
  params: vec4f,
  // 阴影的不透明度与延伸范围。
  shadow: vec4f,
  members: array<Member, ${count}>,`, /* wgsl */`
struct Member {
  // 中心坐标与半宽高。
  box: vec4f,
  // 左上、右上、右下、左下的圆角半径。
  radius: vec4f,
  // 半厚度、底面高度、融合距离、凸透镜强度。
  depth: vec4f,
  // 裁剪范围：左、上、右、下。
  clip: vec4f,
  // 模糊方差、色散、染色比例、高光强度。
  appearance: vec4f,
  // 已乘染色比例的线性染色，以及不透明度。
  color: vec4f,
}`)}
@group(1) @binding(0) var source: texture_2d<f32>;
${BLUR_SIGMAS.map((_, i) => `@group(1) @binding(${i + 1}) var blur${i}: texture_2d<f32>;`).join('\n')}

// 圆角矩形轮廓的有向距离。
fn glass_outline(xy: vec2f, b: vec4f, radii: vec4f) -> f32 {
  let local = xy - b.xy;
  let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), min(b.z, b.w));
  let q = abs(local) - b.zw + radius;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// 圆角实体。倒角截面是三次超椭圆，在平面接合处曲率趋于零，折射压缩不会在固定内圈突然开始。
fn glass_solid(p: vec3f, m: Member) -> f32 {
  let planar = glass_outline(p.xy, m.box, m.radius);
  let bevel = min(m.depth.x * 0.68, min(m.box.z, m.box.w) * 0.5);
  let cross = vec2f(planar + bevel, abs(p.z - m.depth.y - m.depth.x) - m.depth.x + bevel);
  let positive = max(cross, vec2f(0.0));
  let rounded = pow(positive.x * positive.x * positive.x + positive.y * positive.y * positive.y, 1.0 / 3.0);
  let solid = rounded + min(max(cross.x, cross.y), 0.0) - bevel;
  let clipped = max(max(m.clip.x - p.x, p.x - m.clip.z), max(m.clip.y - p.y, p.y - m.clip.w));
  return max(solid, clipped);
}

// 凸透镜在背景平面上产生的取样偏移。
//
// 实体顶面按拱形隆起：沿短边方向是一条抛物线，沿长边方向只在两端一个短边半径的范围内下降。
// 偏移与拱面的坡度成正比，指向实体内部，中间区域因此被放大约 1 / (1 - 强度) 倍；
// 长条形的玻璃只沿短边方向放大，相当于柱面透镜。两个方向的剖面相乘，偏移在整块玻璃内连续。
fn glass_lens(xy: vec2f, m: Member) -> vec2f {
  let local = xy - m.box.xy;
  let reach = max(min(m.box.z, m.box.w), 0.001);
  let inward = clamp((m.box.zw - abs(local)) / reach, vec2f(0.0), vec2f(1.0));
  let slope = 1.0 - inward;
  let dome = 1.0 - slope * slope;
  return -m.depth.w * reach * sign(local) * vec2f(slope.x * dome.y, slope.y * dome.x);
}

// 判断像素是否落在某个成员的平顶区域，且其余成员远到不参与平滑合并。
//
// 平顶区域内实体退化为等厚平板：法线垂直于屏幕，三条光路都沿直线穿过，出射位置就是像素本身。
// 满足条件时返回平板顶面高度，着色器据此跳过求交；否则返回 -1。
// params.y 是其余成员必须保持的最小距离，取所有平滑合并半径之和的上界，保证与逐步求交的结果一致。
fn glass_slab(xy: vec2f) -> f32 {
  var top = -1.0;
  var inside = 0;
  var away = 0;
${each(count, i => `  {
    let m = u.members[${i}];
    let planar = glass_outline(xy, m.box, m.radius);
    let clipped = max(max(m.clip.x - xy.x, xy.x - m.clip.z), max(m.clip.y - xy.y, xy.y - m.clip.w));
    let bevel = min(m.depth.x * 0.68, min(m.box.z, m.box.w) * 0.5);
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

// 所有成员平滑合并后的距离。
fn glass_distance(p: vec3f) -> f32 {${fuse(solid(0, 'p'), i => solid(i, 'p'))}
  return distance;
}

// 最宽截面处的投影距离。任意高度的距离都不小于它。
fn glass_projection(xy: vec2f) -> f32 {${fuse(
  solid(0, 'vec3f(xy, u.members[0].depth.y + u.members[0].depth.x)'),
  i => solid(i, `vec3f(xy, u.members[${i}].depth.y + u.members[${i}].depth.x)`),
)}
  return distance;
}

fn glass_normal(p: vec3f) -> vec3f {
  let e = 0.08;
  let x = glass_distance(p + vec3f(e, 0.0, 0.0)) - glass_distance(p - vec3f(e, 0.0, 0.0));
  let y = glass_distance(p + vec3f(0.0, e, 0.0)) - glass_distance(p - vec3f(0.0, e, 0.0));
  let z = glass_distance(p + vec3f(0.0, 0.0, e)) - glass_distance(p - vec3f(0.0, 0.0, e));
  return normalize(vec3f(x, y, z) + vec3f(0.0, 0.0, 0.00001));
}

// 正交观察光线自上而下寻找入射点。w 为 1 表示命中。
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

// 按 Snell 定律进入玻璃并寻找出射点，允许一次全内反射。
// 返回光线落在背景平面上的位置、玻璃内的路程，以及这条光路的有效程度。
fn glass_exit(entry: vec3f, normal: vec3f, ior: f32) -> vec4f {
  var direction = refract(vec3f(0.0, 0.0, -1.0), normal, 1.0 / ior);
  var p = entry + direction * 0.12;
  var path = 0.12;
  var bounced = false;
  for (var i = 0; i < 64; i++) {
    let d = glass_distance(p);
    if (d > -0.025) {
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
      let step = max(-d * 0.85, 0.035);
      p += direction * step;
      path += step;
    }
  }
  return vec4f(p.xy, path, 0.0);
}
${blurSampler('sample_blur', ['at'])}${blurSampler('sample_blur_rgb', ['red', 'green', 'blue'])}
// 融合后的光学参数（模糊方差、色散、染色比例、高光）、染色与透镜偏移。
struct Material {
  optics: vec4f,
  colored: vec4f,
  color: vec3f,
  lens: vec2f,
}

// 外观与几何使用同一个平滑合并权重，过渡区域会随三维连接处移动。三个值共用一次距离计算。
fn glass_material(p: vec3f) -> Material {
  var optics = u.members[0].appearance;
  var colored = u.members[0].color;
  var lens = glass_lens(p.xy, u.members[0]);${fuse(solid(0, 'p'), i => solid(i, 'p'), i => `    optics = mix(u.members[${i}].appearance, optics, h);
    colored = mix(u.members[${i}].color, colored, h);
    lens = mix(glass_lens(p.xy, u.members[${i}]), lens, h);`)}
  var material: Material;
  material.optics = optics;
  // 透明材质的染色值不应把不透明一端的颜色冲淡。
  material.colored = colored;
  material.color = colored.rgb / max(optics.z, 0.0001);
  material.lens = lens;
  return material;
}

@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
  let outline = glass_projection(xy);
  let distance = glass_projection(xy - vec2f(0.0, 4.0));
  let shadow_alpha = exp(max(distance, 0.0) / max(u.shadow.y, 1.0) * -4.0) * u.shadow.x;
  var result = vec4f(0.0, 0.0, 0.0, shadow_alpha);
  let coverage = 1.0 - smoothstep(-0.7, 0.3, outline);
  // 任意高度的距离都不小于最宽截面处的投影距离，投影在轮廓之外的像素不可能与实体相交，只需绘制阴影。
  if (outline < 0.02) {
    let top = glass_slab(xy);
    if (top >= 0.0) {
      // 平顶区域：光线垂直穿过等厚平板，只受透镜偏移影响，没有轮廓高光。
      let material = glass_material(vec3f(xy, top));
      let here = clamp(screen_uv, vec2f(0.001), vec2f(0.999));
      let through = clamp(screen_uv + material.lens / viewport, vec2f(0.001), vec2f(0.999));
      let transmitted = sample_blur(through, material.optics.x);
      let environment = sample_blur(here, material.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
      let reflected = mix(mix(transmitted, material.color, material.optics.z), environment, clamp(material.optics.w * 0.034, 0.0, 1.0));
      result = vec4f(reflected, material.colored.a * coverage);
    } else {
      let entry = glass_entry(xy);
      if (entry.w > 0.5) {
        let normal = glass_normal(entry.xyz);
        let material = glass_material(entry.xyz);
        let spread = material.optics.y * 0.055;
        let green = glass_exit(entry.xyz, normal, 1.45);
        var red = green;
        var blue = green;
        // 没有色散时三条光路重合，只追踪一次。
        if (spread > 0.00001) {
          red = glass_exit(entry.xyz, normal, 1.45 - spread);
          blue = glass_exit(entry.xyz, normal, 1.45 + spread);
        }
        let red_uv = clamp((red.xy + material.lens) / viewport, vec2f(0.001), vec2f(0.999));
        let green_uv = clamp((green.xy + material.lens) / viewport, vec2f(0.001), vec2f(0.999));
        let blue_uv = clamp((blue.xy + material.lens) / viewport, vec2f(0.001), vec2f(0.999));
        let transmitted = sample_blur_rgb(red_uv, green_uv, blue_uv, material.optics.x);
        // 反射方向由三维法线决定；有限距离的页面环境近似用柔化采样表示表面粗糙度。
        let reflection = reflect(vec3f(0.0, 0.0, -1.0), normal);
        let environment_uv = clamp(screen_uv + reflection.xy * 48.0 / viewport, vec2f(0.001), vec2f(0.999));
        let environment = sample_blur(environment_uv, material.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
        let fresnel = 0.034 + pow(1.0 - clamp(normal.z, 0.0, 1.0), 5.0) * 0.966;
        let tinted = mix(transmitted, material.color, material.optics.z);
        let valid = vec3f(red.w, green.w, blue.w);
        var refracted = tinted;
        // 求交次数耗尽或光线朝向屏幕外时，使用本地柔化背景，避免连接处出现远处亮色碎边。
        if (min(valid.x, min(valid.y, valid.z)) < 1.0) {
          let local_environment = sample_blur(screen_uv, material.optics.x);
          refracted = mix(mix(local_environment, material.color, material.optics.z), tinted, valid);
        }
        let reflected = mix(refracted, environment, clamp(fresnel * material.optics.w, 0.0, 1.0));
        let light = pow(max(dot(normal, normalize(vec3f(-0.45, -0.6, 0.66))), 0.0), 32.0);
        let edge = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);
        let highlight = (light * 0.035 * edge + edge * 0.035) * material.optics.w;
        result = vec4f(reflected + vec3f(highlight * u.params.z), material.colored.a * coverage);
      }
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
