import type { LiquidGlassAttributes } from 'liquid-in-canvas'

/**
 * 标签组里激活项的玻璃属性。
 *
 * 激活项本身是嵌套在外层胶囊里的一滴通透玻璃：只有体积，文字仍由外层胶囊绘制。
 * 同一组按钮共用 `data-glass-morph` 的名字，切换时玻璃属性从旧按钮移到新按钮，
 * 画布渲染下体积从旧位置以液体流动的方式到达新位置；回退实现下是一块直接切换的高亮。
 */
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
