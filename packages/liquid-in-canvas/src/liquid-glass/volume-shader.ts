import type { StageGpu } from '../gpu'
import { BLEND_NORMAL, PipelineTable, shaderPrelude, SLOT_CANVAS, SLOT_TARGET, TARGET_FORMAT, wgslFloat } from '../gpu'
import { BLUR_SIGMAS } from './gaussian'
import { createFieldBakeShader, FIELD_FORMATS, FIELD_TARGETS } from './volume-field-shader'
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

/**
 * 圆角至少比倒角窄这么多（CSS 像素），才认为拐角里有截面查表不准确的一带（见 `glass_corner`）。
 * 差得更少时那一带不到一个像素，与逐步求交的差别看不出来。
 */
export const CORNER_MARGIN = 0.5

/** 依次对每个成员展开一段代码。 */
export function each(count: number, body: (i: number) => string, from = 0): string {
  return Array.from({ length: count - from }, (_, j) => body(j + from)).join('\n')
}

/**
 * 成员按顶面高度（底面高度 + 厚度）从低到高的次序，`fusion_order()` 返回每一名次对应的成员下标。
 * 顶面一样高时下标小的在前。只取决于 uniform，每个像素算出的次序相同。
 */
function fusionOrder(count: number): string {
  const tops = each(count, i => `  let t${i} = u.members[${i}].depth.y + 2.0 * u.members[${i}].depth.x;`)
  const ranks = each(count, (i) => {
    // 名次是排在它前面的成员数：顶面更低，或一样高且下标更小。
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
// 成员按顶面从低到高的次序（下标）。
fn fusion_order() -> array<i32, ${count}> {
  var order: array<i32, ${count}>;
${tops}
${ranks}
  return order;
}`
}

/**
 * 截面参数与外观的合并：按顶面从低到高依次并入，较厚（顶面较高）的成员在自己的平顶范围内完全主导，
 * 往外按 `fusion_ramp` 平滑地让给已经合并的较薄成员。
 *
 * 平面轮廓的平滑合并权重只适合合并距离：它在截断处只有一阶连续，又带着各成员距离场在中轴（对角线、圆心）上的折点，
 * 拿它混合厚度时，小玻璃放进大玻璃中间会在顶面压出一个带棱的浅坑，较薄成员在融合处也会把较厚成员的边缘削薄一圈。
 * 这里的权重只取决于较厚成员轮廓附近的距离，在它的平顶范围内恒为 1：大玻璃完整盖住小玻璃时形体就是大玻璃本身，
 * 中轴上的折点也不会进入截面参数。
 *
 * 让出的范围从轮廓往外延伸“两者较小的融合距离 × (1 + 接近程度)”：刚分进同一组时（矩形间距等于融合距离）
 * 较薄成员离较厚成员的轮廓至少一个融合距离，权重为 0，分组前后画面不跳变；贴在一起时延伸到两倍融合距离。
 * 较薄成员靠近的地方，让出的范围再从较厚成员的平顶边缘开始（往里一个倒角宽度，按较薄成员的远近平滑地缩放）：
 * 厚度相差很大时坡度分摊到较厚成员的倒角与较薄成员两边，不至于在较薄成员上立起一面陡墙。
 *
 * 要求作用域里已有各成员的平面距离 `d0`、`d1`……；`gradients` 为 true 时还要有它们的外法向数组 `grads`。
 * `first` 写入顶面最低的成员 `m` 的值；`blend` 在之后的每一步并入成员 `m`（下标 `index`），可以用权重 `ramp.x`、
 * 权重梯度长度的上界 `slope`，`gradients` 为 true 时还有权重的梯度（一阶近似）`falloff`。
 */
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
    // 已经合并的较薄成员里离这里最近的平面距离${gradients ? '与它的外法向' : ''}。
    var base_distance = 0.0;${gradients ? '\n    var base_gradient = vec2f(0.0);' : ''}
    {
      let m = u.members[order[0]];
${first}
      reach = m.depth.z;
      base_distance = dist[order[0]];${gradients ? '\n      base_gradient = grads[order[0]];' : ''}
    }
    for (var r = 1; r < ${count}; r++) {
      let index = order[r];
      let m = u.members[index];
      let width = min(m.depth.z, reach) * (1.0 + m.extra.w);
      let bevel_width = min(m.profile.x, min(m.box.z, m.box.w));
      let near = fusion_ramp(base_distance, width);
      let inset = bevel_width * near.x;
      let ramp = fusion_ramp(dist[index] + inset, width + inset);
      // ∇(d + inset) 不超过 1 + 倒角宽度 × near.y；宽度随 inset 变化的部分并入同一个上界。
      let slope = ramp.y * (1.0 + 2.0 * bevel_width * near.y);${gradients ? '\n      let falloff = -ramp.y * (grads[index] - bevel_width * near.y * base_gradient);' : ''}
${blend}
      reach = max(reach, m.depth.z);
      if (dist[index] < base_distance) {
        base_distance = dist[index];${gradients ? '\n        base_gradient = grads[index];' : ''}
      }
    }
  }`
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
  // 折射场缓存（混合光路读写缓存的管线）：缓存左上角的纹素位置、缓存倍率与目标倍率之比、
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
  // 剖面查找表的行号（剖面光学与混合光路）、透射背景的饱和度与亮度倍数，
  // 以及与较薄成员的接近程度（见 writeFusionProximity）。
  extra: vec4f,
}`)}
@group(1) @binding(0) var source: texture_2d<f32>;
${BLUR_SIGMAS.map((_, i) => `@group(1) @binding(${i + 1}) var blur${i}: texture_2d<f32>;`).join('\n')}

// 像素所在象限的圆角半径（不超过短边的一半），以及拐角里等距线不再缩小的圆角半径 rounding（见 glass_contour）。
fn glass_rounding(local: vec2f, m: Member) -> vec2f {
  let radii = m.radius;
  let narrow = min(m.box.z, m.box.w);
  let radius = min(select(select(radii.z, radii.y, local.y < 0.0), select(radii.w, radii.x, local.y < 0.0), local.x < 0.0), narrow);
  let bevel = min(m.profile.x, narrow);
  return vec2f(radius, max(min(min(radius, bevel - radius), narrow - bevel), 0.0));
}

// 成员轮廓的有向距离与朝外的单位法向。
//
// 圆角矩形的有向距离往里走，等距线的圆角半径逐渐缩到零，再往里在角上折成直角，法向沿对角线突变。
// 倒角比圆角宽时这条折线落进倒角，两侧的折射方向跳变，画面上从四角各出现一条斜线。
// 这里让等距线的圆角半径缩到 rounding 就不再缩小，折线换成半径为 rounding 的圆弧，法向连续转过。
// rounding 取倒角超出圆角的部分，不超过圆角半径，也不超过倒角最深处还放得下的大小：
// 倒角不比圆角宽时与原来完全相同，胶囊也不变。
// 轮廓外与浅于 radius − rounding 的部分仍是原来的有向距离；更深处的值不大于原来的值，梯度长度不超过 1，
// 求交步长仍然安全。
fn glass_contour(xy: vec2f, m: Member) -> vec3f {
  let b = m.box;
  let local = xy - b.xy;
  let corner = glass_rounding(local, m);
  let radius = corner.x;
  let rounding = corner.y;
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
  // 圆角半径已缩到 rounding 的等距线：在 shift 之外再往里 deeper。
  let e = w.x - w.y;
  let deeper = select(rounding - g, 0.5 * (sqrt(max(2.0 * rounding * rounding - e * e, 0.0)) - w.x - w.y), abs(e) < rounding);
  let normal = max(w + deeper, vec2f(0.0));
  return vec3f(-(shift + deeper), normal / max(length(normal), 0.00001) * side);
}

// 成员轮廓的有向距离。
fn glass_outline(xy: vec2f, m: Member) -> f32 {
  return glass_contour(xy, m).x;
}

// 光线在玻璃内横向走 lateral 以内时，能否走进拐角里截面查表不准确的一带。
// 圆角比倒角窄时，轮廓距离场的中轴（拐角的对角线）有一段落在倒角里：等距线在那里折成直角，
// 或按 glass_contour 换成半径为 rounding、不再缩小的圆弧（距离场不再是到轮廓的真实距离）。
// 光线走到那一带就离开了截面平面，按截面查表与逐步求交的结果不同。
// 象限内的圆弧部分是绕圆角圆心的旋转体，光线沿径向走、不越过 rounding 那一圈时查表仍然准确；
// 直边部分的光线只沿法向走，离对角线不近于 rounding + lateral 时也准确。圆角不比倒角窄时中轴不在倒角里。
fn glass_corner(xy: vec2f, m: Member, lateral: f32) -> bool {
  let local = xy - m.box.xy;
  let corner = glass_rounding(local, m);
  if (corner.x >= min(m.profile.x, min(m.box.z, m.box.w)) - ${wgslFloat(CORNER_MARGIN)}) { return false; }
  let w = abs(local) - m.box.zw + corner.x;
  let reach = corner.y + lateral;
  if (w.x >= 0.0 && w.y >= 0.0) { return length(w) < reach; }
  return abs(w.x - w.y) < reach;
}
${fusionOrder(count)}
// 较厚成员的截面参数与外观向轮廓外延伸的权重与它对平面距离的导数：轮廓内为 1，到 reach 处降到 0，
// 两端的一阶、二阶导数都为零，合并后的顶面没有折线。
fn fusion_ramp(distance: f32, reach: f32) -> vec2f {
  let width = max(reach, 0.001);
  let t = clamp(distance / width, 0.0, 1.0);
  return vec2f(1.0 - t * t * t * (t * (t * 6.0 - 15.0) + 10.0), 30.0 * t * t * (1.0 - t) * (1.0 - t) / width);
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
 * 按成员顺序做平面平滑合并的循环体：与剖面光学的 `glass_field` 用同一个权重，`extra` 在每一步用这个权重混合附带的值。
 * 要求作用域里已有 `var distance`（第一名成员的平面距离）与 `var fusion`，循环内可以用 `m`、`other` 与 `h`。
 */
export function fuseOutlines(count: number, other: (i: number) => string, extra: (i: number) => string = () => ''): string {
  return each(count, i => `  {
    let m = u.members[${i}];
    let other = ${other(i)};
    let k = max(min(fusion, m.depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other - distance) / k, 0.0, 1.0);
${extra(i)}
    distance = mix(other, distance, h) - k * h * (1.0 - h);
    fusion = max(fusion, m.depth.z);
  }`, 1)
}

/**
 * 合并后的轮廓与截面（`glass_body`）。每名成员的平面距离与裁剪距离只算一次：
 *
 * - 轮廓按成员顺序做平面平滑合并（`fuseOutlines`）。裁剪距离用同一个权重混合，混合前截到不深于“半厚度 + 1”：
 *   截面的距离不小于负的半厚度，更深的裁剪距离不起作用；截短后，没有裁剪的成员只把相邻成员的裁剪切面
 *   在融合范围内平滑地推开，不会把它整个抹掉。所有成员共用同一个裁剪范围时结果与逐成员裁剪相同。
 * - 同时记下最近与次近成员（含裁剪）的距离和最近成员的下标，供混合光路分档。
 * - 厚度、底面高度、倒角与曲线由较厚成员主导（`fuseDominance`），并累计它们在平面上的坡度上界：
 *   厚度不同的成员融合时顶面有坡，距离场不再是 1-Lipschitz，求交步长要按 `lipschitz` 缩小，否则会越过表面。
 */
function glassBody(count: number): string {
  return /* wgsl */`fn glass_body(xy: vec2f) -> Body {
  var b: Body;
${each(count, i => `  let d${i} = glass_outline(xy, u.members[${i}]);
  let c${i} = glass_clip(xy, u.members[${i}].clip);`)}
  var distance = d0;
  var fusion = u.members[0].depth.z;
  b.clip = max(c0, -u.members[0].depth.x - 1.0);
  b.owner = 0;
  b.nearest = max(d0, c0);
  b.second = 1000000.0;
${fuseOutlines(count, i => `d${i}`, i => `    b.clip = mix(max(c${i}, -m.depth.x - 1.0), b.clip, h);
    let apart = max(d${i}, c${i});
    if (apart < b.nearest) {
      b.second = b.nearest;
      b.nearest = apart;
      b.owner = ${i};
    } else {
      b.second = min(b.second, apart);
    }`)}
  b.planar = distance;
  var top_slope = 0.0;
  var bottom_slope = 0.0;
  var bevel_slope = 0.0;
${fuseDominance(count, `      b.middle = m.depth.y + m.depth.x;
      b.half_depth = m.depth.x;
      b.bevel = vec2f(min(m.profile.x, min(m.box.z, m.box.w)), m.profile.y);
      b.shape = m.profile.zw;`, `      let w = ramp.x;
      let bevel = vec2f(min(m.profile.x, min(m.box.z, m.box.w)), m.profile.y);
      // mix(a, c, w) 的梯度不超过 (1 − w)·|∇a| + |c − a|·|∇w|，|∇w| 不超过 slope。
      top_slope = (1.0 - w) * top_slope + abs(m.depth.y + 2.0 * m.depth.x - b.middle - b.half_depth) * slope;
      bottom_slope = (1.0 - w) * bottom_slope + abs(m.depth.y - b.middle + b.half_depth) * slope;
      bevel_slope = (1.0 - w) * bevel_slope + max(abs(bevel.x - b.bevel.x), abs(bevel.y - b.bevel.y)) * slope;
      b.middle = mix(b.middle, m.depth.y + m.depth.x, w);
      b.half_depth = mix(b.half_depth, m.depth.x, w);
      b.bevel = mix(b.bevel, bevel, w);
      b.shape = mix(b.shape, m.profile.zw, w);`)}
  b.lipschitz = 1.0 + max(top_slope, bottom_slope) + bevel_slope;
  return b;
}`
}

/**
 * 三维求交：合并后实体的距离场、光线求交与着色。体积着色器与混合光路共用。
 *
 * 坐标使用视口的 CSS 像素，z 轴垂直于屏幕指向观察者，背景平面在 z = 0。
 *
 * 融合的实体不是各成员三维实体的平滑合并，而是先在平面上平滑合并轮廓，再按到合并轮廓的距离套截面：
 * 各成员的倒角不会在连接处相交出折痕，连接处与剖面查表一样是一整块玻璃，三种光路的轮廓与形体一致。
 * 截面参数（厚度、底面高度、倒角）与外观由较厚成员主导，见 `fuseDominance`。
 */
export function raymarchOptics(count: number): string {
  return /* wgsl */`
// 合并后的轮廓与截面：到合并轮廓的平面距离、裁剪距离、中面高度、半厚度、顶面倒角的宽高、
// 倒角曲线的超椭圆指数与底面倒角比例；距离场的 Lipschitz 常数上界；
// 最近成员（含裁剪）的下标、到它与到次近成员的距离（混合光路分档用）。
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

// 截面，planar 是到轮廓的平面距离，height 是相对实体中面的高度。
// 截面是一块平板，边缘按超椭圆弧倒角；指数大于 2 时曲率在平面接合处趋于零，
// 折射压缩不会在固定内圈突然开始。顶面和底面的倒角分别取值，底面按比例缩小。
//
// 倒角在宽高各自归一化的坐标里求超椭圆距离，再乘较短的一边，得到不超过真实距离的下界；
// 指数小于 2 时超椭圆范数的梯度可能大于 1，再按 2^(1/p - 1/2) 缩小。
// 截面不超出平板，平板的距离同样是下界，两者取大，平面部分仍是精确距离，求交不会变慢。
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

// 合并后实体的距离：合并轮廓的截面，再按合并后的裁剪范围切开。
fn glass_distance(p: vec3f) -> f32 {
  let b = glass_body(p.xy);
  return max(glass_section(b.planar, p.z - b.middle, b), b.clip);
}

// 求交用的距离：x 是距离场的值，用来判断是否到达表面；y 是沿 direction 前进时不会越过表面的步长。
// 截面对高度的导数不超过 1，所以竖直的光线按原值前进总是安全的；厚度不同的成员融合处顶面有坡，
// 距离场在平面方向的变化率可以超过 1（glass_body 的 lipschitz），斜着走的光线按方向把两部分合起来缩小步长，
// 否则会越过表面，连接处出现锯齿与碎边。
fn glass_march(p: vec3f, direction: vec3f) -> vec2f {
  let b = glass_body(p.xy);
  let d = max(glass_section(b.planar, p.z - b.middle, b), b.clip);
  return vec2f(d, d / (abs(direction.z) + b.lipschitz * length(direction.xy)));
}

// 最宽截面（中面）处的投影距离。任意高度的距离都不小于它。
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
// 融合后的光学参数（模糊方差、色散、染色比例、高光）、染色与透镜偏移。
struct Material {
  optics: vec4f,
  colored: vec4f,
  color: vec3f,
  lens: vec2f,
  tone: vec2f,
}

// 外观与截面参数用同一个权重合并（较厚成员主导，见 fuseDominance），过渡区域随合并轮廓移动。
fn glass_material(p: vec3f) -> Material {
  let xy = p.xy;
${each(count, i => `  let d${i} = glass_outline(xy, u.members[${i}]);`)}
  var optics: vec4f;
  var colored: vec4f;
  var lens: vec2f;
  var tone: vec2f;
${fuseDominance(count, `      optics = m.appearance;
      colored = m.color;
      lens = glass_lens(xy, m);
      tone = m.extra.yz;`, `      optics = mix(optics, m.appearance, ramp.x);
      colored = mix(colored, m.color, ramp.x);
      lens = mix(lens, glass_lens(xy, m), ramp.x);
      tone = mix(tone, m.extra.yz, ramp.x);`)}
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
 * 读取折射场缓存的管线里不可过滤的绑定（单精度的折射场纹理），按位记录，见 `PipelineSpec.unfilterable`。
 * 写成函数：这几个着色器模块相互引用，模块初始化时 `FIELD_FORMATS` 可能还没有定义。
 */
export function fieldUnfilterable(): number {
  let mask = 0
  for (let i = 0; i < FIELD_FORMATS.length; i++) {
    if (FIELD_FORMATS[i] === 'rgba32float')
      mask |= 1 << (VOLUME_TEXTURES + 1 + i)
  }
  return mask
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
      : [source, ...blurs], fields.length > 0
      ? fieldUnfilterable()
      : 0),
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
    unfilterable: kind === 'field'
      ? fieldUnfilterable()
      : 0,
    format: gpu.formatOf(slot),
    blend: BLEND_NORMAL,
  })))
}

/**
 * 写入折射场缓存的管线表，按成员数量取用。一次绘制同时写三张纹理，不混合；
 * 绑定与混合光路相同（只读其中的查找表）。
 */
export function createFieldBakePipelines(gpu: StageGpu): PipelineTable {
  return new PipelineTable(gpu, 'volume-bake', count => ({
    code: createFieldBakeShader(count),
    entry: 'bake',
    textures: VOLUME_TEXTURES + 1,
    format: TARGET_FORMAT,
    formats: FIELD_FORMATS,
  }))
}
