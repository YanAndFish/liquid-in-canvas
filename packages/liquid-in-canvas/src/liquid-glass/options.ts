import type { GlassDefaults, GlassTheme, GlassVariant } from './defaults'
import { attr, ATTR_OFF, GLASS_SCOPE_ATTR } from '../contract'
import { GLASS_LAYER_RANGE } from '../render-order'
import { clamp, getGlassDefaults, GLASS_LIMITS, normalizeHex } from './defaults'

export type GlassRadius = readonly [number, number, number, number]

/**
 * 液体迁移期间玻璃上的 HTML 内容：`static` 停在元素位置，尺寸过渡时随玻璃展开显露；
 * `clip` 停在元素位置并裁剪在体积之内；`follow` 映射到体积上，随拉伸、回弹和晃动一起变形。
 * @since 0.3.0
 */
export type GlassMorphContent = 'static' | 'clip' | 'follow'

export const GLASS_OPTION_ATTRS = [
  'data-glass-layer',
  'data-glass-fusion',
  'data-glass-elevation',
  'data-glass-radius',
  'data-glass-variant',
  'data-glass-blur',
  'data-glass-refraction',
  'data-glass-bevel-width',
  'data-glass-bevel-height',
  'data-glass-bevel-curve',
  'data-glass-bottom-bevel',
  'data-glass-dispersion',
  'data-glass-ior',
  'data-glass-lens',
  'data-glass-saturation',
  'data-glass-brightness',
  'data-glass-tint',
  'data-glass-tint-alpha',
  'data-glass-specular',
  'data-glass-shadow',
  'data-glass-shadow-size',
  'data-glass-anchor',
  'data-glass-morph',
  'data-glass-morph-from',
  'data-glass-morph-to',
  'data-glass-morph-stretch',
  'data-glass-morph-bounce',
  'data-glass-morph-wobble',
  'data-glass-morph-speed',
  'data-glass-morph-content',
  'data-glass-materialize',
] as const

/** HTML 元素声明的玻璃外观参数，长度均使用 CSS 像素。 */
export interface GlassOptions {
  /** 玻璃绘制层级。只有同层的表面参与融合，数值越大越靠前。 */
  layer: number
  /** 两个表面间形成连接的距离范围，0 表示关闭融合。 */
  fusion: number
  /** 玻璃底面到背景平面的距离。 */
  elevation: number
  /** 左上、右上、右下、左下的圆角半径。 */
  radius: GlassRadius
  /** 背景高斯模糊的目标标准差，0 表示清晰透射。 */
  blur: number
  /** 三维实体的半厚度参考值，实际厚度受控件短边限制。 */
  refraction: number
  /** 倒角的水平宽度与半厚度之比。 */
  bevelWidth: number
  /** 倒角的垂直高度与半厚度之比，1 表示侧面没有竖直部分。 */
  bevelHeight: number
  /** 倒角曲线的超椭圆指数：1 是直线斜面，2 是椭圆弧，越大越接近直角。 */
  bevelCurve: number
  /** 底面倒角相对顶面倒角的比例，0 表示底面是带直角边的平面。 */
  bottomBevel: number
  /** RGB 采样位置的分离强度。 */
  dispersion: number
  /** 折射率。 */
  ior: number
  /** 凸透镜强度，0 表示平板。玻璃中间的背景被放大约 1 / (1 − lens) 倍。 */
  lens: number
  /** 透射背景的饱和度倍数，1 表示不变。 */
  saturation: number
  /** 透射背景的亮度倍数，1 表示不变。 */
  brightness: number
  /** 用于承托前景文字的十六进制颜色。 */
  tint: string
  /** 染色比例，0 表示无染色。 */
  tintAlpha: number
  /** 轮廓反光强度。 */
  specular: number
  /** 外侧阴影的不透明度。 */
  shadow: number
  /** 阴影的延伸范围。 */
  shadowSize: number
  /** regular 使用较强模糊与主题染色，clear 保留更多背景细节。 */
  variant: GlassVariant
  /** 用于定位的非 drawable 祖先选择器，null 表示使用 offsetParent。 */
  anchor: string | null
  /**
   * 液体迁移。null 表示关闭；空字符串表示这块玻璃自己的位置或尺寸变化时以液体流动过渡；
   * 非空时还作为名字，标识同一块玻璃：同名的玻璃离开、另一块同名玻璃出现时，体积从旧位置流向新位置。
   * 声明了 `morphFrom` 或 `morphTo` 而没有声明名字时为空字符串。
   */
  morph: string | null
  /**
   * 出现时从中分出的玻璃名字，按顺序取第一块在场的。没有声明时取 `morphTo`。
   * @since 0.5.0
   */
  morphFrom: readonly string[]
  /**
   * 消失时并入的玻璃名字，按顺序取第一块在场的。没有声明时取 `morphFrom`。
   * @since 0.5.0
   */
  morphTo: readonly string[]
  /** 液体迁移的拉伸，0–2。0 表示整体平移，越大前缘与后缘拉得越开。 */
  morphStretch: number
  /** 液体迁移的回弹，0–1。0 表示不越过目标。 */
  morphBounce: number
  /** 液体迁移的晃动，0–1。0 表示到达后不晃动。 */
  morphWobble: number
  /**
   * 液体迁移的速度倍数，0.25–4。1 为缺省节奏，越大越快到达，回弹与晃动的形状不变。
   * @since 0.6.0
   */
  morphSpeed: number
  /** 液体迁移期间内容的表现，见 `GlassMorphContent`。0.3.0 起。 */
  morphContent: GlassMorphContent
  /** 出现与移除时以材质化过渡：光线先弯折再成为磨砂。`data-glass-materialize="none"` 关闭。 */
  materialize: boolean
}

const SCOPE_SELECTOR = attr(GLASS_SCOPE_ATTR)

const UNSCOPED = new Set<string>(['data-glass-morph', 'data-glass-morph-from', 'data-glass-morph-to'])

export function glassScopes(element: HTMLElement): HTMLElement[] {
  const scopes: HTMLElement[] = []
  let scope = element.parentElement?.closest<HTMLElement>(SCOPE_SELECTOR)
  while (scope) {
    scopes.push(scope)
    scope = scope.parentElement?.closest<HTMLElement>(SCOPE_SELECTOR)
  }
  return scopes
}

export class GlassAttributeSource {
  private readonly element: HTMLElement
  private readonly scopes: HTMLElement[]

  constructor(element: HTMLElement) {
    this.element = element
    this.scopes = glassScopes(element)
  }

  get(name: string): string | null {
    const own = this.element.getAttribute(name)
    if (own !== null || UNSCOPED.has(name))
      return own
    for (const scope of this.scopes) {
      const value = scope.getAttribute(name)
      if (value !== null)
        return value
    }
    return null
  }
}

function numberAttribute(
  source: GlassAttributeSource,
  name: string,
  fallback: number,
  [min, max]: readonly [number, number],
): number {
  const raw = source.get(name)
  if (raw === null)
    return fallback

  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value))
    return fallback

  return clamp(value, min, max)
}

function expandRadius(values: readonly number[], fallback: number): GlassRadius {
  if (values.length <= 1) {
    const value = values[0] ?? fallback
    return [value, value, value, value]
  }
  if (values.length === 2) {
    const [a, b] = values as [number, number]
    return [a, b, a, b]
  }
  if (values.length === 3) {
    const [a, b, c] = values as [number, number, number]
    return [a, b, c, b]
  }

  const [a, b, c, d] = values as [number, number, number, number]
  return [a, b, c, d]
}

function parseRadius(raw: string | null, fallback: number): GlassRadius {
  if (raw === null)
    return expandRadius([], fallback)

  const values = raw
    .split(/[\s,]+/)
    .map(token => Number.parseFloat(token))
    .filter(value => Number.isFinite(value))
    .slice(0, 4)
    .map(value => clamp(value, ...GLASS_LIMITS.radius))

  return expandRadius(values, fallback)
}

function parseVariant(raw: string | null): GlassVariant {
  if (raw?.trim().toLowerCase() === 'clear')
    return 'clear'

  return 'regular'
}

function parseTint(raw: string | null, fallback: string): string {
  if (raw === null)
    return fallback

  return normalizeHex(raw) ?? fallback
}

function parseAnchor(raw: string | null): string | null {
  return raw?.trim() || null
}

export function parseMorph(raw: string | null): string | null {
  const value = raw?.trim()
  if (value === undefined || value.toLowerCase() === ATTR_OFF)
    return null
  if (value.toLowerCase() === 'true')
    return ''
  return value
}

export function parseMorphNames(raw: string | null): string[] {
  return raw?.trim().split(/\s+/).filter(name => name.length > 0) ?? []
}

function parseMorphContent(raw: string | null): GlassMorphContent {
  const value = raw?.trim().toLowerCase()
  return value === 'clip' || value === 'follow'
    ? value
    : 'static'
}

function parseMaterialize(raw: string | null): boolean {
  const value = raw?.trim().toLowerCase()
  return value !== 'none' && value !== ATTR_OFF
}

export function parseGlassOptions(
  element: HTMLElement,
  theme: GlassTheme,
  defaults: GlassDefaults = getGlassDefaults(),
): GlassOptions {
  const source = new GlassAttributeSource(element)
  const variant = parseVariant(source.get('data-glass-variant'))
  const material = defaults.materials[variant][theme]
  const from = parseMorphNames(element.getAttribute('data-glass-morph-from'))
  const to = parseMorphNames(element.getAttribute('data-glass-morph-to'))
  const morph = parseMorph(element.getAttribute('data-glass-morph'))
  const related = from.length > 0 || to.length > 0

  return {
    layer: Math.round(numberAttribute(source, 'data-glass-layer', 0, GLASS_LAYER_RANGE)),
    fusion: numberAttribute(source, 'data-glass-fusion', defaults.fusion, GLASS_LIMITS.fusion),
    elevation: numberAttribute(source, 'data-glass-elevation', defaults.elevation, GLASS_LIMITS.elevation),
    radius: parseRadius(source.get('data-glass-radius'), defaults.radius),
    blur: numberAttribute(source, 'data-glass-blur', material.blur, GLASS_LIMITS.blur),
    refraction: numberAttribute(source, 'data-glass-refraction', material.refraction, GLASS_LIMITS.refraction),
    bevelWidth: numberAttribute(source, 'data-glass-bevel-width', material.bevelWidth, GLASS_LIMITS.bevelWidth),
    bevelHeight: numberAttribute(source, 'data-glass-bevel-height', material.bevelHeight, GLASS_LIMITS.bevelHeight),
    bevelCurve: numberAttribute(source, 'data-glass-bevel-curve', material.bevelCurve, GLASS_LIMITS.bevelCurve),
    bottomBevel: numberAttribute(source, 'data-glass-bottom-bevel', material.bottomBevel, GLASS_LIMITS.bottomBevel),
    dispersion: numberAttribute(source, 'data-glass-dispersion', material.dispersion, GLASS_LIMITS.dispersion),
    ior: numberAttribute(source, 'data-glass-ior', material.ior, GLASS_LIMITS.ior),
    lens: numberAttribute(source, 'data-glass-lens', material.lens, GLASS_LIMITS.lens),
    saturation: numberAttribute(source, 'data-glass-saturation', material.saturation, GLASS_LIMITS.saturation),
    brightness: numberAttribute(source, 'data-glass-brightness', material.brightness, GLASS_LIMITS.brightness),
    tint: parseTint(source.get('data-glass-tint'), material.tint),
    tintAlpha: numberAttribute(source, 'data-glass-tint-alpha', material.tintAlpha, GLASS_LIMITS.tintAlpha),
    specular: numberAttribute(source, 'data-glass-specular', material.specular, GLASS_LIMITS.specular),
    shadow: numberAttribute(source, 'data-glass-shadow', material.shadow, GLASS_LIMITS.shadow),
    shadowSize: numberAttribute(source, 'data-glass-shadow-size', material.shadowSize, GLASS_LIMITS.shadowSize),
    variant,
    anchor: parseAnchor(source.get('data-glass-anchor')),
    morph: morph ?? (related ? '' : null),
    morphFrom: from.length > 0
      ? from
      : to,
    morphTo: to.length > 0
      ? to
      : from,
    morphStretch: numberAttribute(source, 'data-glass-morph-stretch', defaults.morphStretch, GLASS_LIMITS.morphStretch),
    morphBounce: numberAttribute(source, 'data-glass-morph-bounce', defaults.morphBounce, GLASS_LIMITS.morphBounce),
    morphWobble: numberAttribute(source, 'data-glass-morph-wobble', defaults.morphWobble, GLASS_LIMITS.morphWobble),
    morphSpeed: numberAttribute(source, 'data-glass-morph-speed', defaults.morphSpeed, GLASS_LIMITS.morphSpeed),
    morphContent: parseMorphContent(source.get('data-glass-morph-content')),
    materialize: parseMaterialize(source.get('data-glass-materialize')),
  }
}

export function glassOptionsSignature(options: GlassOptions): string {
  return JSON.stringify({
    layer: options.layer,
    fusion: options.fusion,
    elevation: options.elevation,
    radius: options.radius,
    blur: options.blur,
    refraction: options.refraction,
    bevelWidth: options.bevelWidth,
    bevelHeight: options.bevelHeight,
    bevelCurve: options.bevelCurve,
    bottomBevel: options.bottomBevel,
    dispersion: options.dispersion,
    ior: options.ior,
    lens: options.lens,
    saturation: options.saturation,
    brightness: options.brightness,
    tint: options.tint,
    tintAlpha: options.tintAlpha,
    specular: options.specular,
    shadow: options.shadow,
    shadowSize: options.shadowSize,
    variant: options.variant,
    anchor: options.anchor,
    morph: options.morph,
    morphFrom: options.morphFrom,
    morphTo: options.morphTo,
    morphStretch: options.morphStretch,
    morphBounce: options.morphBounce,
    morphWobble: options.morphWobble,
    morphSpeed: options.morphSpeed,
    morphContent: options.morphContent,
    materialize: options.materialize,
  })
}
