export type GlassVariant = 'regular' | 'clear'
export type GlassRadius = readonly [number, number, number, number]
export type GlassTheme = 'light' | 'dark'

export interface GlassOptions {
  radius: GlassRadius
  blur: number
  refraction: number
  dispersion: number
  tint: string
  tintAlpha: number
  specular: number
  shadow: number
  shadowSize: number
  variant: GlassVariant
  anchor: string | null
}

interface GlassPreset {
  blur: number
  refraction: number
  dispersion: number
  tint: string
  tintAlpha: number
  specular: number
  shadow: number
  shadowSize: number
}

const DEFAULT_RADIUS = 28
const RADIUS_MAX = 2000

const PRESETS: Record<GlassVariant, Record<GlassTheme, GlassPreset>> = {
  regular: {
    dark: {
      blur: 18,
      refraction: 22,
      dispersion: 0.25,
      tint: '#ffffff',
      tintAlpha: 0.08,
      specular: 0.7,
      shadow: 0.4,
      shadowSize: 32,
    },
    light: {
      blur: 18,
      refraction: 22,
      dispersion: 0.25,
      tint: '#f7f2e8',
      tintAlpha: 0.34,
      specular: 0.7,
      shadow: 0.4,
      shadowSize: 32,
    },
  },
  clear: {
    dark: {
      blur: 8,
      refraction: 18,
      dispersion: 0.34,
      tint: '#ffffff',
      tintAlpha: 0.02,
      specular: 0.9,
      shadow: 0.3,
      shadowSize: 28,
    },
    light: {
      blur: 8,
      refraction: 18,
      dispersion: 0.34,
      tint: '#f7f2e8',
      tintAlpha: 0.12,
      specular: 0.9,
      shadow: 0.3,
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
