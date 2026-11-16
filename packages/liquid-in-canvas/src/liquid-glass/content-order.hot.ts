import type { VolumeSurface } from './fusion.hot'
import { createStackRecord } from './pools'

export interface StackRecord {
  frame: number
  context: boolean
  level: number
}

export class PaintOrder {
  private frame = 0
  private readonly records = new WeakMap<HTMLElement, StackRecord>()
  private left: HTMLElement[] = []
  private right: HTMLElement[] = []

  begin(): void {
    this.frame++
  }

  compare(a: HTMLElement, b: HTMLElement): number {
    if (a === b)
      return 0
    const left = this.left
    const right = this.right
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

function fillPath(path: HTMLElement[], element: HTMLElement): number {
  let count = 0
  for (let current: HTMLElement | null = element; current; current = current.parentElement)
    path[count++] = current
  return count
}

export function covers(rect: Pick<VolumeSurface, 'left' | 'top' | 'width' | 'height'>, other: VolumeSurface): boolean {
  return rect.left < other.left + other.width
    && rect.left + rect.width > other.left
    && rect.top < other.top + other.height
    && rect.top + rect.height > other.top
}
