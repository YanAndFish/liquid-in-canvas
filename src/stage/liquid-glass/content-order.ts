import type { VolumeSurface } from './fusion'

/** 记录元素所在的 CSS 层叠上下文。 */
interface StackingContext {
  /** 建立层叠上下文的元素。 */
  element: HTMLElement
  /** 当前上下文内的 z-index，auto 按零处理。 */
  z: number
}

/** 返回从页面根部到元素的层叠上下文路径。 */
function stackingPath(element: HTMLElement): StackingContext[] {
  const result: StackingContext[] = []
  let current: HTMLElement | null = element
  while (current) {
    const style = getComputedStyle(current)
    const positioned = style.position !== '' && style.position !== 'static'
    const explicitZ = style.zIndex !== '' && style.zIndex !== 'auto'
    const transformed = style.transform !== '' && style.transform !== 'none'
    const filtered = style.filter !== '' && style.filter !== 'none'
    if ((positioned && explicitZ) || style.position === 'fixed' || style.position === 'sticky'
      || transformed || filtered || Number.parseFloat(style.opacity) < 1 || style.isolation === 'isolate') {
      result.unshift({ element: current, z: Number.parseInt(style.zIndex, 10) || 0 })
    }
    current = current.parentElement
  }
  return result
}

/** 比较 HTML 前后顺序，优先考虑祖先的层叠上下文，再比较 DOM 顺序。 */
export function compareHtmlPaintOrder(a: HTMLElement, b: HTMLElement): number {
  const left = stackingPath(a)
  const right = stackingPath(b)
  let index = 0
  while (left[index] && right[index] && left[index]!.element === right[index]!.element)
    index++
  const difference = (left[index]?.z ?? 0) - (right[index]?.z ?? 0)
  if (difference !== 0)
    return difference
  if (a === b)
    return 0
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1
}

/** 返回覆盖当前内容的上层玻璃；仅相邻但未重叠的表面不遮挡文字。 */
export function contentOccluders(surface: VolumeSurface, above: readonly VolumeSurface[]): VolumeSurface[] {
  return above.filter(other => surface.left < other.left + other.width
    && surface.left + surface.width > other.left
    && surface.top < other.top + other.height
    && surface.top + surface.height > other.top)
}
