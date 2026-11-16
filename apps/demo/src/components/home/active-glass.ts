import type { LiquidGlassAttributes } from 'liquid-in-canvas'

export function activeGlass(group: string, active: boolean): LiquidGlassAttributes {
  if (!active)
    return {}
  return {
    'data-liquid-glass': '',
    'data-glass-morph': group,
    'data-glass-radius': '999',
    'data-glass-variant': 'clear',
    'data-glass-blur': '1',
    'data-glass-refraction': '12',
    'data-glass-lens': '0.3',
    'data-glass-specular': '1.4',
    'data-glass-shadow': '0.22',
    'data-glass-shadow-size': '10',
  }
}
