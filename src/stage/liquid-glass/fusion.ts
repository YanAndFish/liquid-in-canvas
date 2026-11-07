import type { GlassOptions } from './options'

/** 参与三维融合的一块玻璃，坐标使用视口 CSS 像素。 */
export interface VolumeSurface {
  /** 生命周期内稳定的表面编号。 */
  id: number
  /** 左侧位置。 */
  left: number
  /** 顶部位置。 */
  top: number
  /** 未变形宽度。 */
  width: number
  /** 未变形高度。 */
  height: number
  /** 外观与玻璃层级。 */
  options: GlassOptions
  /** 祖先裁剪范围，依次为左、上、右、下。 */
  clip: readonly [number, number, number, number]
  /** 页面切换产生的透明度。 */
  opacity: number
  /** 遮罩下的亮度比例。背景快照已压暗，此值只作用于染色和高光。 */
  brightness: number
  /** 同层内的 HTML 绘制顺序，归一化到 0–1。 */
  paintOrder: number
  /** 按压弹簧的当前强度。 */
  press: number
}

/** 返回两个矩形间的最短距离；重叠时为零。 */
export function surfaceGap(a: VolumeSurface, b: VolumeSurface): number {
  return Math.hypot(
    Math.max(a.left - b.left - b.width, b.left - a.left - a.width, 0),
    Math.max(a.top - b.top - b.height, b.top - a.top - a.height, 0),
  )
}

/** 按层级与邻近关系分组，间接相连的表面一起绘制。 */
export function groupGlassSurfaces(surfaces: readonly VolumeSurface[]): VolumeSurface[][] {
  const groups: VolumeSurface[][] = []
  const remaining = new Set(surfaces)
  for (const first of surfaces) {
    if (!remaining.delete(first))
      continue
    const group = [first]
    for (let index = 0; index < group.length; index++) {
      const current = group[index]!
      for (const candidate of remaining) {
        if (candidate.options.layer !== current.options.layer)
          continue
        const reach = Math.min(candidate.options.fusion, current.options.fusion)
        if (reach <= 0 || surfaceGap(current, candidate) > reach)
          continue
        remaining.delete(candidate)
        group.push(candidate)
      }
    }
    groups.push(group.sort((a, b) => a.id - b.id))
  }
  return groups
}

/** 将玻璃层级映射到场景顺序，留出上层内容的位置。 */
export function glassRenderOrder(layer: number): number {
  return 900 + layer * 10
}
