import type { VolumeSurface } from './fusion.hot'
import { createStackRecord } from './pools'

/** 一个元素在本帧的层叠上下文：是否创建上下文，以及它的 z-index。 */
export interface StackRecord {
  /** 读取样式时的帧编号，不等于当前帧时需要重新读取。 */
  frame: number
  context: boolean
  level: number
}

/**
 * HTML 前后顺序。每帧调用一次 `begin()`，同一帧内每个元素的样式只读取一次。
 *
 * 比较时找到两个元素的共同祖先，从分叉后的第一个元素往下找首个层叠上下文，比较它们的 z-index；
 * 相同时按 DOM 顺序。共同祖先的层叠上下文相同，不需要读取它们的样式。
 */
export class PaintOrder {
  private frame = 0
  private readonly records = new WeakMap<HTMLElement, StackRecord>()
  private left: HTMLElement[] = []
  private right: HTMLElement[] = []

  /** 开始新的一帧，之后读取的样式反映页面的当前状态。 */
  begin(): void {
    this.frame++
  }

  /** a 先于 b 绘制时返回负数，后于 b 时返回正数。 */
  compare(a: HTMLElement, b: HTMLElement): number {
    if (a === b)
      return 0
    const left = this.left
    const right = this.right
    // 路径从元素一直写到根部，下标越大越靠近根部。
    let i = fillPath(left, a) - 1
    let j = fillPath(right, b) - 1
    while (i >= 0 && j >= 0 && left[i] === right[j]) {
      i--
      j--
    }
    const difference = this.firstLevel(left, i) - this.firstLevel(right, j)
    if (difference !== 0)
      return difference
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1
  }

  /** 从分叉处往元素方向找首个层叠上下文的 z-index。分支没有层叠上下文时返回零。 */
  private firstLevel(path: readonly HTMLElement[], start: number): number {
    for (let k = start; k >= 0; k--) {
      const record = this.read(path[k]!)
      if (record.context)
        return record.level
    }
    return 0
  }

  private read(element: HTMLElement): StackRecord {
    const record = this.records.get(element) ?? this.track(element)
    if (record.frame === this.frame)
      return record
    record.frame = this.frame
    const style = getComputedStyle(element)
    const positioned = style.position !== '' && style.position !== 'static'
    const explicitZ = style.zIndex !== '' && style.zIndex !== 'auto'
    const transformed = style.transform !== '' && style.transform !== 'none'
    const filtered = style.filter !== '' && style.filter !== 'none'
    record.context = (positioned && explicitZ) || style.position === 'fixed' || style.position === 'sticky'
      || transformed || filtered || Number.parseFloat(style.opacity) < 1 || style.isolation === 'isolate'
    record.level = record.context
      ? Number.parseInt(style.zIndex, 10) || 0
      : 0
    return record
  }

  private track(element: HTMLElement): StackRecord {
    const record = createStackRecord()
    this.records.set(element, record)
    return record
  }
}

/** 把元素到根部的路径写进 `path`，返回长度。 */
function fillPath(path: HTMLElement[], element: HTMLElement): number {
  let count = 0
  for (let current: HTMLElement | null = element; current; current = current.parentElement)
    path[count++] = current
  return count
}

/** 上层玻璃是否盖住这块内容矩形；仅相邻但未重叠的表面不遮挡文字。 */
export function covers(rect: Pick<VolumeSurface, 'left' | 'top' | 'width' | 'height'>, other: VolumeSurface): boolean {
  return rect.left < other.left + other.width
    && rect.left + rect.width > other.left
    && rect.top < other.top + other.height
    && rect.top + rect.height > other.top
}
