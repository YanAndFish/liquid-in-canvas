import { wgslFloat } from '../gpu'
import { FIELD_TARGETS } from './volume-field-shader'
import { profileField, profileOptics } from './volume-profile-shader'
import { clipCoverage, each, raymarchOptics, REFLECTION_VARIANCE, VOLUME_TEXTURES, volumeCommon } from './volume-shader'

/**
 * 查找表里的横向范围换算成像素时乘的余量与附加的像素数。
 * 查找表在参考厚度下追踪，步长与阈值以像素为单位，换到别的厚度时只是近似成比例；
 * 另外要盖住有限差分法线与全内反射后那一步的位移。
 */
export const HYBRID_REACH_SCALE = 1.1
export const HYBRID_REACH_PAD = 2
/** 裁剪范围与玻璃之间除光线横向位移与半厚度外再留出的距离：阴影取样的偏移与边缘的过渡带。 */
export const HYBRID_CLIP_PAD = 6

/** 光线在玻璃内可能的横向位移（像素）。`reach` 是查找表里这一行的最大位移与半厚度之比。 */
export function hybridLateral(reach: number, halfDepth: number): number {
  return reach * halfDepth * HYBRID_REACH_SCALE + HYBRID_REACH_PAD
}

/**
 * 每名成员的轮廓距离只算一次：合并出投影距离（与 `glass_projection` 相同），同时找出最近与次近的成员。
 * 声明 `owner`、`nearest`、`second` 与 `outline`，要求作用域里已有 `xy`。混合着色器与折射场缓存的写入共用。
 */
export function hybridOwner(count: number): string {
  return /* wgsl */`  var owner = 0;
  var nearest = 0.0;
  var second = 1000000.0;
  var outline = 0.0;
  var fusion = u.members[0].depth.z;
  {
    let m = u.members[0];
    let planar = glass_outline(xy, m.box, m.radius);
    let clipped = glass_clip(xy, m.clip);
    outline = max(glass_section(planar, 0.0, m), clipped);
    nearest = max(planar, clipped);
  }
${each(count, i => `  {
    let m = u.members[${i}];
    let planar = glass_outline(xy, m.box, m.radius);
    let clipped = glass_clip(xy, m.clip);
    let other = max(glass_section(planar, 0.0, m), clipped);
    let k = max(min(fusion, m.depth.z) * 2.0, 0.001);
    let h = clamp(0.5 + 0.5 * (other - outline) / k, 0.0, 1.0);
    outline = mix(other, outline, h) - k * h * (1.0 - h);
    fusion = max(fusion, m.depth.z);
    let apart = max(planar, clipped);
    if (apart < nearest) {
      second = nearest;
      nearest = apart;
      owner = ${i};
    } else {
      second = min(second, apart);
    }
  }`, 1)}`
}

/**
 * 归属成员的查表参数与分档条件。声明 `m`、`clipped`、`field`、`on_slab`（平顶）与 `alone`（可以按这名成员查表），
 * 要求作用域里已有 `hybridOwner()` 的结果。
 */
export function hybridTier(): string {
  return /* wgsl */`    let m = u.members[owner];
    let contour = outline_gradient(xy, m.box, m.radius);
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
    field.tone = m.extra.yz;
    let on_slab = contour.x + field.bevel < -0.5 && clipped < -1.0 && second >= u.params.w;
    // 光线在玻璃内离开入射位置的最大横向距离。裁剪边还要再远一个半厚度，
    // 否则它会成为距离场里最近的面，求交的步长随之变小。
    let lateral = lut_at(field, 3.0).x * m.depth.x * ${wgslFloat(HYBRID_REACH_SCALE)} + ${wgslFloat(HYBRID_REACH_PAD)};
    let alone = second >= u.params.w + lateral && clipped <= -(lateral + m.depth.x);`
}

/**
 * 求交档的着色。不带缓存时每帧逐步求交。
 *
 * 带缓存时先读折射场：纹素里有这个像素的光路（入射高度不小于零）就只算外观的合并权重、再取样背景；
 * 没有（缓存范围之外、写入时不在求交档、视线没有碰到实体）仍然逐步求交，所以结果不依赖缓存是否完整。
 * `u.field.w` 小于 1 时与二维合并后的查表结果（剖面光学在这个像素的画面）按比例混合，
 * 让“运动时查表”与“静止后求交”之间的切换淡入淡出。
 */
function traceTier(cached: boolean): string {
  if (!cached)
    return /* wgsl */`        shaded = glass_trace(xy, screen_uv);`
  return /* wgsl */`        let texel = vec2i(floor(in.position.xy * u.field.z - u.field.xy));
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
        if (u.field.w < 1.0) {
          let approximate = glass_lookup(glass_field(xy), xy, screen_uv);
          // 只有一方认为这里有实体时，按比例淡入或淡出。
          if (approximate.a >= 0.0 && shaded.a >= 0.0) {
            shaded = mix(approximate, shaded, u.field.w);
          } else if (approximate.a >= 0.0) {
            shaded = vec4f(approximate.rgb, approximate.a * (1.0 - u.field.w));
          } else if (shaded.a >= 0.0) {
            shaded.a *= u.field.w;
          }
        }`
}

/**
 * 生成指定成员数量的混合光路体积着色器：逐像素在平顶捷径、剖面查表与三维求交之间选择。
 *
 * 融合只在成员彼此靠近的地方改变实体的形状，裁剪也只在裁剪边附近切开实体。离它们足够远的像素上，
 * 光路只穿过一名成员，结果与这名成员单独存在时相同，可以直接查表；其余像素逐步求交。
 * 每个像素按到各成员轮廓（含裁剪）的距离找出最近与次近的成员，分三档：
 *
 * - 平顶：落在最近成员的倒角内侧，次近成员不参与平滑合并。光线垂直穿过等厚平板。
 * - 查表：次近成员与裁剪边离得比“平滑合并的范围 + 光线在玻璃内的横向位移”更远。
 *   横向位移取自查找表里这个位置的追踪结果，轮廓附近发生全内反射的光线走得远，倒角内侧接近零。
 * - 求交：其余像素，也就是融合连接处与裁剪边附近。
 *
 * 判定条件保证查表的像素上三维距离场与只有这名成员时逐点相同，两档交界处的结果一致，
 * 成员移动时交界随之连续移动。覆盖率与阴影在三档里用同一个投影距离，轮廓没有接缝。
 *
 * 读取的 uniform 与纹理和剖面光学相同。`params.w` 是其余成员不参与平滑合并的最小距离。
 *
 * `cached` 为 true 时求交档改读折射场缓存（见 `volume-field-shader.ts` 与 `field-cache.hot.ts`），
 * 多绑定几张折射场纹理，放在查找表之后。
 */
export function createHybridVolumeShader(count: number, cached = false): string {
  const fields = cached
    ? /* wgsl */`${each(FIELD_TARGETS, i => `@group(1) @binding(${VOLUME_TEXTURES + 1 + i}) var field${i}: texture_2d<f32>;`)}
${profileField(count)}`
    : ''
  return /* wgsl */`${volumeCommon(count)}${raymarchOptics(count)}${profileOptics()}${fields}
@fragment
fn volume(in: VertexOutput) -> @location(0) vec4f {
  let viewport = u.screen.zw;
  let screen_uv = in.position.xy / u.screen.xy;
  let xy = screen_uv * viewport;
${hybridOwner(count)}
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
      // 平顶：光线垂直穿过等厚平板，只受透镜偏移影响，没有轮廓高光。其余成员不参与合并，外观就是这名成员的。
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
