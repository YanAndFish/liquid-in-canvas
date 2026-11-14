export type GlassVariant = 'regular' | 'clear'
export type GlassTheme = 'light' | 'dark'

/** 一种材质在一个主题下的外观，长度均使用 CSS 像素。 */
export interface GlassMaterial {
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
  /** 凸透镜强度，0 表示平板。玻璃中间的背景被放大约 1 / (1 − lens) 倍，只对画布渲染有效。 */
  lens: number
  /** 透射背景的饱和度倍数，1 表示不变。磨砂材质略微提高，让背景颜色更鲜明。 */
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
}

/** 元素未用 `data-glass-*` 声明时采用的参数。 */
export interface GlassDefaults {
  /** 圆角半径。 */
  radius: number
  /** 两个表面间形成连接的距离范围，0 表示关闭融合。 */
  fusion: number
  /** 玻璃底面到背景平面的距离。 */
  elevation: number
  /** 液体迁移的拉伸：前后缘的速度差，0 表示整体平移。 */
  morphStretch: number
  /** 液体迁移的回弹：前缘越过目标后弹回的程度，0 表示不越过。 */
  morphBounce: number
  /** 液体迁移的晃动：到达后在拉长与压扁之间振荡的程度，0 表示不晃动。 */
  morphWobble: number
  /** 各材质在深浅主题下的外观。 */
  materials: Record<GlassVariant, Record<GlassTheme, GlassMaterial>>
}

/** `setGlassDefaults()` 接受的局部修改，未列出的字段保持不变。 */
export interface GlassDefaultsPatch {
  radius?: number
  fusion?: number
  elevation?: number
  morphStretch?: number
  morphBounce?: number
  morphWobble?: number
  materials?: {
    [V in GlassVariant]?: {
      [T in GlassTheme]?: Partial<GlassMaterial>
    }
  }
}

type NumericKey = Exclude<keyof GlassMaterial, 'tint'> | 'radius' | 'fusion' | 'elevation' | 'morphStretch' | 'morphBounce' | 'morphWobble'

/** 各数值参数的取值范围，属性与默认值都会被限制在其中。 */
export const GLASS_LIMITS: Readonly<Record<NumericKey, readonly [min: number, max: number]>> = {
  radius: [0, 2000],
  fusion: [0, 100],
  elevation: [0, 100],
  morphStretch: [0, 2],
  morphBounce: [0, 1],
  morphWobble: [0, 1],
  blur: [0, 80],
  refraction: [0, 80],
  bevelWidth: [0.1, 4],
  bevelHeight: [0.05, 1],
  bevelCurve: [1, 8],
  bottomBevel: [0, 1],
  dispersion: [0, 1],
  lens: [0, 0.6],
  saturation: [0, 3],
  brightness: [0.5, 1.5],
  tintAlpha: [0, 1],
  specular: [0, 2],
  shadow: [0, 1],
  shadowSize: [0, 100],
}

const VARIANTS: readonly GlassVariant[] = ['regular', 'clear']
const THEMES: readonly GlassTheme[] = ['light', 'dark']
const MATERIAL_NUMBERS = [
  'blur',
  'refraction',
  'bevelWidth',
  'bevelHeight',
  'bevelCurve',
  'bottomBevel',
  'dispersion',
  'lens',
  'saturation',
  'brightness',
  'tintAlpha',
  'specular',
  'shadow',
  'shadowSize',
] as const
const BASE_NUMBERS = [
  'radius',
  'fusion',
  'elevation',
  'morphStretch',
  'morphBounce',
  'morphWobble',
] as const

/** 库内置的默认参数。 */
export const BUILTIN_GLASS_DEFAULTS: GlassDefaults = deepFreeze({
  radius: 28,
  fusion: 32,
  elevation: 16,
  morphStretch: 1,
  morphBounce: 0.33,
  morphWobble: 0.35,
  materials: {
    regular: {
      dark: {
        blur: 18,
        refraction: 80,
        bevelWidth: 0.45,
        bevelHeight: 1,
        bevelCurve: 3,
        bottomBevel: 1,
        dispersion: 0.3,
        lens: 0.04,
        saturation: 1.3,
        brightness: 1,
        tint: '#171b20',
        tintAlpha: 0.28,
        specular: 0.7,
        shadow: 0.16,
        shadowSize: 32,
      },
      light: {
        blur: 18,
        refraction: 80,
        bevelWidth: 0.45,
        bevelHeight: 1,
        bevelCurve: 3,
        bottomBevel: 1,
        dispersion: 0.3,
        lens: 0.04,
        saturation: 1.3,
        brightness: 1.06,
        tint: '#f6f6f8',
        tintAlpha: 0.32,
        specular: 0.7,
        shadow: 0.16,
        shadowSize: 32,
      },
    },
    clear: {
      dark: {
        blur: 2,
        refraction: 80,
        bevelWidth: 0.45,
        bevelHeight: 1,
        bevelCurve: 3,
        bottomBevel: 1,
        dispersion: 0.4,
        lens: 0.12,
        saturation: 1.15,
        brightness: 1,
        tint: '#ffffff',
        tintAlpha: 0.01,
        specular: 0.9,
        shadow: 0.12,
        shadowSize: 28,
      },
      light: {
        blur: 2,
        refraction: 80,
        bevelWidth: 0.45,
        bevelHeight: 1,
        bevelCurve: 3,
        bottomBevel: 1,
        dispersion: 0.4,
        lens: 0.12,
        saturation: 1.15,
        brightness: 1,
        tint: '#f7f2e8',
        tintAlpha: 0.04,
        specular: 0.9,
        shadow: 0.12,
        shadowSize: 28,
      },
    },
  },
})

let current: GlassDefaults = BUILTIN_GLASS_DEFAULTS
const listeners = new Set<(defaults: GlassDefaults) => void>()

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null)
      deepFreeze(child)
  }
  return Object.freeze(value)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 把三位或六位十六进制颜色规范为小写六位；格式不符时返回 null。 */
export function normalizeHex(raw: string): string | null {
  const hex = raw.trim().toLowerCase()
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(hex))
    return null
  if (hex.length === 4)
    return `#${hex.slice(1).split('').map(char => char + char).join('')}`

  return hex
}

function mergeNumber(key: NumericKey, next: unknown, previous: number): number {
  return typeof next === 'number' && Number.isFinite(next)
    ? clamp(next, ...GLASS_LIMITS[key])
    : previous
}

function mergeMaterial(previous: GlassMaterial, patch: Partial<GlassMaterial> | undefined): GlassMaterial {
  if (!patch)
    return previous
  const next = { ...previous }
  for (const key of MATERIAL_NUMBERS)
    next[key] = mergeNumber(key, patch[key], previous[key])
  if (typeof patch.tint === 'string')
    next.tint = normalizeHex(patch.tint) ?? previous.tint
  return next
}

function merge(previous: GlassDefaults, patch: GlassDefaultsPatch): GlassDefaults {
  const next: GlassDefaults = {
    radius: previous.radius,
    fusion: previous.fusion,
    elevation: previous.elevation,
    morphStretch: previous.morphStretch,
    morphBounce: previous.morphBounce,
    morphWobble: previous.morphWobble,
    materials: {
      regular: { ...previous.materials.regular },
      clear: { ...previous.materials.clear },
    },
  }
  for (const key of BASE_NUMBERS)
    next[key] = mergeNumber(key, patch[key], previous[key])
  for (const variant of VARIANTS) {
    for (const theme of THEMES)
      next.materials[variant][theme] = mergeMaterial(previous.materials[variant][theme], patch.materials?.[variant]?.[theme])
  }
  return deepFreeze(next)
}

function publish(next: GlassDefaults): GlassDefaults {
  if (JSON.stringify(next) === JSON.stringify(current))
    return current
  current = next
  for (const listener of [...listeners])
    listener(current)
  return current
}

/** 返回当前生效的全局默认参数。对象已冻结，修改请使用 `setGlassDefaults()`。 */
export function getGlassDefaults(): GlassDefaults {
  return current
}

/**
 * 修改全局默认参数。只影响没有用 `data-glass-*` 声明对应属性的玻璃，
 * 已启动的舞台会在下一帧应用新值。数值会被限制在 `GLASS_LIMITS` 内，无效值被忽略。
 */
export function setGlassDefaults(patch: GlassDefaultsPatch): GlassDefaults {
  return publish(merge(current, patch))
}

/** 恢复库内置的默认参数。 */
export function resetGlassDefaults(): GlassDefaults {
  return publish(BUILTIN_GLASS_DEFAULTS)
}

/** 监听默认参数变化，返回取消监听的函数。 */
export function onGlassDefaultsChange(listener: (defaults: GlassDefaults) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
