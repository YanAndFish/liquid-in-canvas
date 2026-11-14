import type { VolumeSurface } from './fusion'

/** 创建 HTML 前后顺序比较函数。每次排序都创建一个，以读取当前的祖先样式。 */
export function createHtmlPaintOrderComparator(): (a: HTMLElement, b: HTMLElement) => number {
  const paths = new Map<HTMLElement, readonly HTMLElement[]>()
  const stackingLevels = new Map<HTMLElement, number | null>()

  /** 返回从页面根部到元素的 DOM 路径。 */
  function ancestorPath(element: HTMLElement): readonly HTMLElement[] {
    const cached = paths.get(element)
    if (cached)
      return cached

    const path: HTMLElement[] = []
    for (let current: HTMLElement | null = element; current; current = current.parentElement)
      path.push(current)
    path.reverse()
    paths.set(element, path)
    return path
  }

  /** 返回分支首个层叠上下文的 z-index。分支没有层叠上下文时返回零。 */
  function firstStackingLevel(path: readonly HTMLElement[], start: number): number {
    for (let index = start; index < path.length; index++) {
      const element = path[index]!
      let z = stackingLevels.get(element)
      if (z === undefined) {
        const style = getComputedStyle(element)
        const positioned = style.position !== '' && style.position !== 'static'
        const explicitZ = style.zIndex !== '' && style.zIndex !== 'auto'
        const transformed = style.transform !== '' && style.transform !== 'none'
        const filtered = style.filter !== '' && style.filter !== 'none'
        const createsContext = (positioned && explicitZ) || style.position === 'fixed' || style.position === 'sticky'
          || transformed || filtered || Number.parseFloat(style.opacity) < 1 || style.isolation === 'isolate'
        z = createsContext
          ? Number.parseInt(style.zIndex, 10) || 0
          : null
        stackingLevels.set(element, z)
      }
      if (z !== null)
        return z
    }
    return 0
  }

  return (a, b) => {
    if (a === b)
      return 0

    const left = ancestorPath(a)
    const right = ancestorPath(b)
    let index = 0
    // 共同祖先的层叠上下文相同，只有分叉后的第一个上下文影响比较结果。
    while (index < left.length && left[index] === right[index])
      index++
    const difference = firstStackingLevel(left, index) - firstStackingLevel(right, index)
    if (difference !== 0)
      return difference
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1
  }
}

/** 返回覆盖当前内容矩形的上层玻璃；仅相邻但未重叠的表面不遮挡文字。 */
export function contentOccluders(
  surface: Pick<VolumeSurface, 'left' | 'top' | 'width' | 'height'>,
  above: readonly VolumeSurface[],
): VolumeSurface[] {
  return above.filter(other => surface.left < other.left + other.width
    && surface.left + surface.width > other.left
    && surface.top < other.top + other.height
    && surface.top + surface.height > other.top)
}
