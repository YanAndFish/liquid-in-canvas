import { createCoverRect, growFloat64, growInt32 } from './pools'

/** 轴对齐矩形，坐标使用 CSS 像素。 */
export interface CoverRect {
  left: number
  top: number
  right: number
  bottom: number
}

function hasArea(rect: CoverRect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top
}

/** 把数值插入已排序的前 `count` 项，已存在时不重复插入。返回新的项数。 */
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

/**
 * 把一组可能重叠的矩形换成覆盖同一片区域、互不重叠的矩形。
 *
 * 按所有上下边把区域切成横条，每条内合并相交的水平区间；上下相邻且左右边相同的矩形再接成一个。
 * 用来把一张已经混合好的图分块画回去：每个像素只能画一次，否则半透明部分会叠加两遍。
 *
 * 结果写进 `rects` 的前 `count` 项。矩形对象与中间数组都复用，每次 `build()` 重新填写。
 */
export class CoverBuilder {
  readonly rects: CoverRect[] = []
  count = 0
  private edges = new Float64Array(32)
  /** 当前横条里的水平区间，按左边排列，依次为左、右。 */
  private spans = new Float64Array(64)
  private currentLeft = new Float64Array(32)
  private currentRight = new Float64Array(32)
  /** 上一条与当前条的矩形在 `rects` 中的下标，用于纵向合并。 */
  private previous = new Int32Array(32)
  private merged = new Int32Array(32)

  /** 按 `input` 的前 `inputCount` 项计算覆盖。 */
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
      // 当前条成为下一条的“上一条”。
      this.merged = this.previous
      this.previous = merged
      previousCount = currentCount
    }
  }

  /** 收集与横条相交的矩形的水平区间，按左边排列，左边相同的保持输入顺序。 */
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

  /** 合并相交的区间，结果写进 `currentLeft` / `currentRight`。 */
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

  /** 与上一条左右边相同的矩形向下延伸，否则新增一个矩形。返回它在 `rects` 中的下标。 */
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

  /** 中间数组至少能容纳 `inputCount` 个矩形。 */
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
