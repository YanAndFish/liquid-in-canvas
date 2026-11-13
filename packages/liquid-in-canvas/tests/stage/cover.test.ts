import type { CoverRect } from '../../src/liquid-glass/cover'
import { describe, expect, it } from 'vitest'
import { disjointCover } from '../../src/liquid-glass/cover'

function rect(left: number, top: number, right: number, bottom: number): CoverRect {
  return { left, top, right, bottom }
}

function area(rects: readonly CoverRect[]): number {
  return rects.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0)
}

/** 任意两个矩形的内部都不相交。 */
function disjoint(rects: readonly CoverRect[]): boolean {
  return rects.every((a, i) => rects.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top))
}

describe('不重叠覆盖', () => {
  it('互不相交的矩形原样保留', () => {
    const cover = disjointCover([
      rect(0, 0, 10, 10),
      rect(20, 0, 30, 10),
    ])
    expect(cover).toHaveLength(2)
    expect(area(cover)).toBe(200)
  })

  it('重叠部分只覆盖一次', () => {
    const cover = disjointCover([
      rect(0, 0, 10, 10),
      rect(5, 5, 15, 15),
    ])
    expect(disjoint(cover)).toBe(true)
    // 两个 100 的矩形重叠 25。
    expect(area(cover)).toBe(175)
  })

  it('被完全包含的矩形不增加覆盖', () => {
    const cover = disjointCover([
      rect(0, 0, 100, 100),
      rect(10, 10, 20, 20),
    ])
    expect(cover).toEqual([
      rect(0, 0, 100, 100),
    ])
  })

  it('上下相接且等宽的横条合并成一个', () => {
    const cover = disjointCover([
      rect(0, 0, 10, 10),
      rect(0, 10, 10, 30),
    ])
    expect(cover).toEqual([
      rect(0, 0, 10, 30),
    ])
  })

  it('忽略没有面积的矩形', () => {
    expect(disjointCover([
      rect(0, 0, 0, 10),
      rect(5, 5, 4, 9),
    ])).toEqual([])
  })
})
