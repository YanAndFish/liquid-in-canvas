export type GlassVariant = 'regular' | 'clear'
export type GlassRadius = readonly [number, number, number, number]
export type GlassTheme = 'light' | 'dark'

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
  /** RGB 采样位置的分离强度。 */
  dispersion: number
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
}

type GlassPreset = Omit<GlassOptions, 'radius' | 'variant' | 'anchor' | 'layer' | 'fusion' | 'elevation'>

const DEFAULT_RADIUS = 28
const RADIUS_MAX = 2000

const PRESETS: Record<GlassVariant, Record<GlassTheme, GlassPreset>> = {
  regular: {
    dark: {
      blur: 18,
      refraction: 24,
      dispersion: 0.3,
      tint: '#171b20',
      tintAlpha: 0.28,
      specular: 0.7,
      shadow: 0.32,
      shadowSize: 32,
    },
    light: {
      blur: 18,
      refraction: 24,
      dispersion: 0.3,
      tint: '#f6f6f8',
      tintAlpha: 0.32,
      specular: 0.7,
      shadow: 0.32,
      shadowSize: 32,
    },
  },
  clear: {
    dark: {
      blur: 8,
      refraction: 20,
      dispersion: 0.4,
      tint: '#ffffff',
      tintAlpha: 0.01,
      specular: 0.9,
      shadow: 0.26,
      shadowSize: 28,
    },
    light: {
      blur: 8,
      refraction: 20,
      dispersion: 0.4,
      tint: '#f7f2e8',
      tintAlpha: 0.04,
      specular: 0.9,
      shadow: 0.26,
      shadowSize: 28,
    },
  },
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function numberAttribute(
  element: HTMLElement,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = element.getAttribute(name)
  if (raw === null)
    return fallback

  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value))
    return fallback

  return clamp(value, min, max)
}

function expandRadius(values: readonly number[]): GlassRadius {
  if (values.length <= 1) {
    const value = values[0] ?? DEFAULT_RADIUS
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

function parseRadius(raw: string | null): GlassRadius {
  if (raw === null)
    return expandRadius([])

  const values = raw
    .split(/[\s,]+/)
    .map(token => Number.parseFloat(token))
    .filter(value => Number.isFinite(value))
    .slice(0, 4)
    .map(value => clamp(value, 0, RADIUS_MAX))

  return expandRadius(values)
}

function parseVariant(raw: string | null): GlassVariant {
  if (raw?.trim().toLowerCase() === 'clear')
    return 'clear'

  return 'regular'
}

function normalizeHex(raw: string): string | null {
  const hex = raw.trim().toLowerCase()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(hex))
    return null
  if (hex.length === 4)
    return `#${hex.slice(1).split('').map(char => char + char).join('')}`

  return hex
}

function parseTint(raw: string | null, fallback: string): string {
  if (raw === null)
    return fallback

  return normalizeHex(raw) ?? fallback
}

function parseAnchor(raw: string | null): string | null {
  return raw?.trim() || null
}

export function parseGlassOptions(element: HTMLElement, theme: GlassTheme): GlassOptions {
  const variant = parseVariant(element.getAttribute('data-glass-variant'))
  const preset = PRESETS[variant][theme]

  return {
    layer: Math.round(numberAttribute(element, 'data-glass-layer', 0, -100, 100)),
    fusion: numberAttribute(element, 'data-glass-fusion', 32, 0, 100),
    elevation: numberAttribute(element, 'data-glass-elevation', 16, 0, 100),
    radius: parseRadius(element.getAttribute('data-glass-radius')),
    blur: numberAttribute(element, 'data-glass-blur', preset.blur, 0, 80),
    refraction: numberAttribute(element, 'data-glass-refraction', preset.refraction, 0, 80),
    dispersion: numberAttribute(element, 'data-glass-dispersion', preset.dispersion, 0, 1),
    tint: parseTint(element.getAttribute('data-glass-tint'), preset.tint),
    tintAlpha: numberAttribute(element, 'data-glass-tint-alpha', preset.tintAlpha, 0, 1),
    specular: numberAttribute(element, 'data-glass-specular', preset.specular, 0, 2),
    shadow: numberAttribute(element, 'data-glass-shadow', preset.shadow, 0, 1),
    shadowSize: numberAttribute(element, 'data-glass-shadow-size', preset.shadowSize, 0, 100),
    variant,
    anchor: parseAnchor(element.getAttribute('data-glass-anchor')),
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
    dispersion: options.dispersion,
    tint: options.tint,
    tintAlpha: options.tintAlpha,
    specular: options.specular,
    shadow: options.shadow,
    shadowSize: options.shadowSize,
    variant: options.variant,
    anchor: options.anchor,
  })
}
