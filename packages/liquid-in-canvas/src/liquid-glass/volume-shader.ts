import type { StageGpu } from '../gpu'
import { BLEND_NORMAL, PipelineTable, shaderPrelude, SLOT_CANVAS, SLOT_TARGET, TARGET_FORMAT, wgslFloat } from '../gpu'
import { BLUR_SIGMAS } from './gaussian'
import { createFieldBakeShader, FIELD_TARGETS } from './volume-field-shader'
import { createHybridVolumeShader } from './volume-hybrid-shader'
import { createProfileVolumeShader } from './volume-profile-shader'

/** 体积组 uniform 中矩形与目标尺寸之后、成员之前的浮点数个数：`params`、`shadow`、`valid` 与 `field`。 */
export const VOLUME_GROUP_FLOATS = 16
/** 每个成员占用的浮点数个数，对应着色器里的 `Member`。 */
export const VOLUME_MEMBER_FLOATS = 32
/** 体积着色器取样的纹理数量：背景加各级模糊。 */
export const VOLUME_TEXTURES = 1 + BLUR_SIGMAS.length

/** 反射取样在透射方差之上附加的粗糙度，单位为 CSS 像素的平方。 */
export const REFLECTION_VARIANCE = 64

/** 依次对每个成员展开一段代码。 */
export function each(count: number, body: (i: number) => string, from = 0): string {
  return Array.from({ length: count - from }, (_, j) => body(j + from)).join('\n')
}

/**
 * 按方差选择高斯层的取样函数。
 *
 * 相邻两层之外的权重恒为 0 或 1，因此每次只取样真正参与插值的层。
 * 这些纹理都只有一级，显式取第 0 级可以在分支内取样而不依赖屏幕空间导数。
 * 传入一个坐标时三通道共用一次取样，传入三个坐标时按 RGB 光路分别取样。
 */
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

/**
 * 两种体积着色器共用的部分：uniform 与成员结构、背景与模糊纹理的绑定、圆角矩形距离与凸透镜偏移。
 */
export function volumeCommon(count: number): string {
  return /* wgsl */`${shaderPrelude(`
  // 求交起点的高度、平顶捷径要求的最小间距、染色与高光的亮度比例、混合光路要求的最小间距。
  params: vec4f,
  // 阴影的不透明度与延伸范围。
  shadow: vec4f,
  // 背景取样坐标的有效范围（归一化）：左、上、右、下。多层玻璃的上层背景只在这个范围内画好。
  valid: vec4f,
  // 折射场缓存（只有混合光路的缓存管线读取）：缓存左上角在视口中的位置、每个 CSS 像素的纹素数、
  // 缓存结果相对查表近似的比例（切换时交叉淡化）。
  field: vec4f,
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
  // 顶面倒角的宽度与高度、倒角曲线的超椭圆指数、底面倒角比例。
  profile: vec4f,
  // 剖面查找表的行号（剖面光学与混合光路）、透射背景的饱和度与亮度倍数，最后一项保留。
  extra: vec4f,
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

// 到裁剪范围边缘的有向距离，范围之内为负。
fn glass_clip(xy: vec2f, clip: vec4f) -> f32 {
  return max(max(clip.x - xy.x, xy.x - clip.z), max(clip.y - xy.y, xy.y - clip.w));
}

// 透射背景的饱和度与亮度：按线性亮度保持明暗，再整体提亮。
fn glass_tone(color: vec3f, tone: vec2f) -> vec3f {
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(luminance), color, tone.x) * tone.y, vec3f(0.0));
}

// 阴影按背景亮度调整：亮背景上保留，暗背景与照片上淡下去，接近系统玻璃几乎看不见阴影的效果。
fn shadow_strength(at: vec2f, variance: f32) -> f32 {
  let backdrop = sample_blur(clamp(at, u.valid.xy, u.valid.zw), variance + ${wgslFloat(REFLECTION_VARIANCE)});
  let luminance = dot(backdrop, vec3f(0.2126, 0.7152, 0.0722));
  return mix(0.35, 1.0, smoothstep(0.2, 0.8, luminance));
}
${blurSampler('sample_blur', ['at'])}${blurSampler('sample_blur_rgb', ['red', 'green', 'blue'])}`
}

/** 各成员的裁剪范围合成的覆盖率，写进 `clip_coverage`。 */
export function clipCoverage(count: number): string {
  return /* wgsl */`  var clip_coverage = 0.0;
${each(count, i => `  {
    let outside = glass_clip(xy, u.members[${i}].clip);
    clip_coverage = max(clip_coverage, 1.0 - smoothstep(-0.5, 0.5, outside));
  }`)}`
}

/**
 * 三维求交：圆角实体的距离场、平滑合并、光线求交与着色。体积着色器与混合光路共用。
 *
 * 坐标使用视口的 CSS 像素，z 轴垂直于屏幕指向观察者，背景平面在 z = 0。
 */
export function raymarchOptics(count: number): string {
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

  return /* wgsl */`
// 圆角实体的截面，planar 是到轮廓的平面距离，height 是相对实体中面的高度。
// 截面是一块平板，边缘按超椭圆弧倒角；指数大于 2 时曲率在平面接合处趋于零，
// 折射压缩不会在固定内圈突然开始。顶面和底面的倒角分别取值，底面按比例缩小。
//
// 倒角在宽高各自归一化的坐标里求超椭圆距离，再乘较短的一边，得到不超过真实距离的下界；
// 指数小于 2 时超椭圆范数的梯度可能大于 1，再按 2^(1/p - 1/2) 缩小。
// 截面不超出平板，平板的距离同样是下界，两者取大，平面部分仍是精确距离，求交不会变慢。
fn glass_section(planar: f32, height: f32, m: Member) -> f32 {
  let scale = select(m.profile.w, 1.0, height > 0.0);
  let bevel = max(vec2f(min(m.profile.x, min(m.box.z, m.box.w)), m.profile.y) * scale, vec2f(0.5));
  let unit = vec2f(planar + bevel.x, abs(height) - m.depth.x + bevel.y) / bevel;
  let positive = max(unit, vec2f(0.0));
  let power = m.profile.z;
  let rounded = pow(pow(positive.x, power) + pow(positive.y, power), 1.0 / power);
  let lipschitz = min(1.0, exp2(0.5 - 1.0 / power));
  let curved = (rounded + min(max(unit.x, unit.y), 0.0) - 1.0) * min(bevel.x, bevel.y) * lipschitz;
  return max(curved, max(planar, abs(height) - m.depth.x));
}

// 圆角实体：截面再按裁剪范围切开。
fn glass_solid(p: vec3f, m: Member) -> f32 {
  let planar = glass_outline(p.xy, m.box, m.radius);
  return max(glass_section(planar, p.z - (m.depth.y + m.depth.x), m), glass_clip(p.xy, m.clip));
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
// 融合后的光学参数（模糊方差、色散、染色比例、高光）、染色与透镜偏移。
struct Material {
  optics: vec4f,
  colored: vec4f,
  color: vec3f,
  lens: vec2f,
  tone: vec2f,
}

// 外观与几何使用同一个平滑合并权重，过渡区域会随三维连接处移动。三个值共用一次距离计算。
fn glass_material(p: vec3f) -> Material {
  var optics = u.members[0].appearance;
  var colored = u.members[0].color;
  var lens = glass_lens(p.xy, u.members[0]);
  var tone = u.members[0].extra.yz;${fuse(solid(0, 'p'), i => solid(i, 'p'), i => `    optics = mix(u.members[${i}].appearance, optics, h);
    colored = mix(u.members[${i}].color, colored, h);
    lens = mix(glass_lens(p.xy, u.members[${i}]), lens, h);
    tone = mix(u.members[${i}].extra.yz, tone, h);`)}
  var material: Material;
  material.optics = optics;
  // 透明材质的染色值不应把不透明一端的颜色冲淡。
  material.colored = colored;
  material.color = colored.rgb / max(optics.z, 0.0001);
  material.lens = lens;
  material.tone = tone;
  return material;
}

// 一条视线的光路，与背景无关：入射点的高度与法线，三条光路落在背景平面上的位置（xy）与有效程度（z）。
// 折射场缓存保存的就是这些量。
struct Paths {
  height: f32,
  normal: vec3f,
  red: vec3f,
  green: vec3f,
  blue: vec3f,
}

// 从入射点追踪三条光路。spread 是红蓝两条光路的折射率偏移。
fn glass_paths(entry: vec3f, spread: f32) -> Paths {
  var paths: Paths;
  paths.height = entry.z;
  paths.normal = glass_normal(entry);
  let green = glass_exit(entry, paths.normal, 1.45);
  var red = green;
  var blue = green;
  // 没有色散时三条光路重合，只追踪一次。
  if (spread > 0.00001) {
    red = glass_exit(entry, paths.normal, 1.45 - spread);
    blue = glass_exit(entry, paths.normal, 1.45 + spread);
  }
  paths.red = red.xyw;
  paths.green = green.xyw;
  paths.blue = blue.xyw;
  return paths;
}

// 按光路取样背景并着色：返回颜色与融合后的不透明度。
fn glass_shade(screen_uv: vec2f, material: Material, paths: Paths) -> vec4f {
  let viewport = u.screen.zw;
  let normal = paths.normal;
  let red_uv = clamp((paths.red.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let green_uv = clamp((paths.green.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let blue_uv = clamp((paths.blue.xy + material.lens) / viewport, u.valid.xy, u.valid.zw);
  let transmitted = glass_tone(sample_blur_rgb(red_uv, green_uv, blue_uv, material.optics.x), material.tone);
  // 反射方向由三维法线决定；有限距离的页面环境近似用柔化采样表示表面粗糙度。
  let reflection = reflect(vec3f(0.0, 0.0, -1.0), normal);
  let environment_uv = clamp(screen_uv + reflection.xy * 48.0 / viewport, u.valid.xy, u.valid.zw);
  let environment = sample_blur(environment_uv, material.optics.x + ${wgslFloat(REFLECTION_VARIANCE)});
  let fresnel = 0.034 + pow(1.0 - clamp(normal.z, 0.0, 1.0), 5.0) * 0.966;
  let tinted = mix(transmitted, material.color, material.optics.z);
  let valid = vec3f(paths.red.z, paths.green.z, paths.blue.z);
  var refracted = tinted;
  // 求交次数耗尽或光线朝向屏幕外时，使用本地柔化背景，避免连接处出现远处亮色碎边。
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

// 逐步求交并着色：返回颜色与融合后的不透明度；光线没有碰到实体时不透明度为 -1。
fn glass_trace(xy: vec2f, screen_uv: vec2f) -> vec4f {
  let entry = glass_entry(xy);
  if (entry.w <= 0.5) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let material = glass_material(entry.xyz);
  return glass_shade(screen_uv, material, glass_paths(entry.xyz, material.optics.y * 0.055));
}
`
}

/**
 * 生成指定成员数量的体积着色器：圆角实体的距离场、平滑合并、光线求交与着色。
 *
 * 着色器只取决于成员数量，成员的位置与外观逐帧写入 uniform。
 */
export function createVolumeShader(count: number): string {
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}
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
  // 任意高度的距离都不小于最宽截面处的投影距离，投影在轮廓之外的像素不可能与实体相交，只需绘制阴影。
  if (outline < 0.02) {
    let top = glass_slab(xy);
    if (top >= 0.0) {
      // 平顶区域：光线垂直穿过等厚平板，只受透镜偏移影响，没有轮廓高光。
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

/** 体积着色器取样的背景与各级模糊的绑定，以及创建它时模糊纹理的代数。 */
export interface VolumeTextures {
  generation: number
  group: GPUBindGroup
}

/**
 * 冷路径：背景视图、模糊纹理、查找表或折射场缓存变化后，重新创建体积着色器的纹理绑定。
 * `lut` 只有剖面光学与混合光路需要，放在各级模糊之后；`fields` 是折射场缓存的几张纹理，放在查找表之后。
 */
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
      : [source, ...blurs]),
  }
}

/**
 * 体积管线的种类：三维求交、剖面查表、混合光路里逐像素在两者之间选择的着色器，
 * 以及读取折射场缓存的混合着色器（`field`）。
 */
export type VolumePipelineKind = 'raymarch' | 'profile' | 'hybrid' | 'field'

/** 生成一种管线在给定成员数量下的着色器。 */
function volumeShaderOf(kind: VolumePipelineKind, count: number): string {
  if (kind === 'profile')
    return createProfileVolumeShader(count)
  if (kind === 'hybrid' || kind === 'field')
    return createHybridVolumeShader(count, kind === 'field')
  return createVolumeShader(count)
}

/** 一种管线取样的纹理数量：背景与各级模糊，查表的几种多一张查找表，读缓存的再多几张折射场。 */
function volumeTexturesOf(kind: VolumePipelineKind): number {
  if (kind === 'raymarch')
    return VOLUME_TEXTURES
  return kind === 'field'
    ? VOLUME_TEXTURES + 1 + FIELD_TARGETS
    : VOLUME_TEXTURES + 1
}

/**
 * 体积管线表，下标是格式位置（画布、离屏目标），表内按成员数量取用。
 * 着色器只取决于成员数量，同一数量的两张表共用一个着色器模块。
 * 剖面查表与混合光路多取样一张查找表，见 `volume-profile-shader.ts` 与 `volume-hybrid-shader.ts`。
 */
export function createVolumePipelines(gpu: StageGpu, kind: VolumePipelineKind = 'raymarch'): PipelineTable[] {
  const prefix = kind === 'raymarch'
    ? 'volume'
    : `volume-${kind}`
  return [SLOT_CANVAS, SLOT_TARGET].map(slot => new PipelineTable(gpu, `${prefix}:${slot}`, count => ({
    code: volumeShaderOf(kind, count),
    entry: 'volume',
    textures: volumeTexturesOf(kind),
    format: gpu.formatOf(slot),
    blend: BLEND_NORMAL,
  })))
}

/**
 * 写入折射场缓存的管线表，按成员数量取用。一次绘制同时写几张半精度纹理，不混合；
 * 绑定与混合光路相同（只读其中的查找表）。
 */
export function createFieldBakePipelines(gpu: StageGpu): PipelineTable {
  return new PipelineTable(gpu, 'volume-bake', count => ({
    code: createFieldBakeShader(count),
    entry: 'bake',
    textures: VOLUME_TEXTURES + 1,
    format: TARGET_FORMAT,
    targets: FIELD_TARGETS,
  }))
}
