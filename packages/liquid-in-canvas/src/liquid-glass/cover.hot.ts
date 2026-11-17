import { createCoverRect, growFloat64, growInt32 } from './pools'

export interface CoverRect {
  left: number
  top: number
  right: number
  bottom: number
}

function hasArea(rect: CoverRect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top
}

function insertUnique(values: Float64Array, count: number, value: number): number {
  let index = count
  while (index > 0 && values[index - 1]! > value)
    index--
  if (index > 0 && values[index - 1] === value)
    return count
  values.copyWithin(index + 1, index, count)
  values[index] = value
  return count + 1
}

export class CoverBuilder {
  readonly rects: CoverRect[] = []
  count = 0
  private edges = new Float64Array(32)
  private spans = new Float64Array(64)
  private currentLeft = new Float64Array(32)
  private currentRight = new Float64Array(32)
  private previous = new Int32Array(32)
  private merged = new Int32Array(32)

  build(input: readonly CoverRect[], inputCount: number): void {
    this.reserve(inputCount)
    this.count = 0
    const edges = this.edges
    let edgeCount = 0
    for (let i = 0; i < inputCount; i++) {
      const rect = input[i]!
      if (!hasArea(rect))
        continue
      edgeCount = insertUnique(edges, edgeCount, rect.top)
      edgeCount = insertUnique(edges, edgeCount, rect.bottom)
    }
    let previousCount = 0
    for (let e = 0; e + 1 < edgeCount; e++) {
      const top = edges[e]!
      const bottom = edges[e + 1]!
      const spanCount = this.collectSpans(input, inputCount, top, bottom)
      const currentCount = this.mergeSpans(spanCount)
      const merged = this.merged
      for (let c = 0; c < currentCount; c++)
        merged[c] = this.place(top, bottom, this.currentLeft[c]!, this.currentRight[c]!, previousCount)
      this.merged = this.previous
      this.previous = merged
      previousCount = currentCount
    }
  }

  private collectSpans(input: readonly CoverRect[], inputCount: number, top: number, bottom: number): number {
    const spans = this.spans
    let count = 0
    for (let i = 0; i < inputCount; i++) {
      const rect = input[i]!
      if (!hasArea(rect) || rect.top >= bottom || rect.bottom <= top)
        continue
      let index = count
      while (index > 0 && spans[(index - 1) * 2]! > rect.left)
        index--
      spans.copyWithin((index + 1) * 2, index * 2, count * 2)
      spans[index * 2] = rect.left
      spans[index * 2 + 1] = rect.right
      count++
    }
    return count
  }

  private mergeSpans(spanCount: number): number {
    const spans = this.spans
    const lefts = this.currentLeft
    const rights = this.currentRight
    let count = 0
    for (let s = 0; s < spanCount; s++) {
      const left = spans[s * 2]!
      const right = spans[s * 2 + 1]!
      if (count > 0 && left <= rights[count - 1]!) {
        rights[count - 1] = Math.max(rights[count - 1]!, right)
      }
      else {
        lefts[count] = left
        rights[count] = right
        count++
      }
    }
    return count
  }

  private place(top: number, bottom: number, left: number, right: number, previousCount: number): number {
    const previous = this.previous
    for (let p = 0; p < previousCount; p++) {
      const above = this.rects[previous[p]!]!
      if (above.bottom === top && above.left === left && above.right === right) {
        above.bottom = bottom
        return previous[p]!
      }
    }
    const index = this.count++
    const rect = this.rects[index] ?? this.grow(index)
    rect.left = left
    rect.top = top
    rect.right = right
    rect.bottom = bottom
    return index
  }

  private grow(index: number): CoverRect {
    const rect = createCoverRect()
    this.rects[index] = rect
    return rect
  }

  private reserve(inputCount: number): void {
    if (this.edges.length >= inputCount * 2 && this.currentLeft.length >= inputCount)
      return
    this.edges = growFloat64(inputCount * 2)
    this.spans = growFloat64(inputCount * 2)
    this.currentLeft = growFloat64(inputCount)
    this.currentRight = growFloat64(inputCount)
    this.previous = growInt32(inputCount)
    this.merged = growInt32(inputCount)
  }
}
