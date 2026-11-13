/** 轴对齐矩形，坐标使用 CSS 像素。 */
export interface CoverRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 把一组可能重叠的矩形换成覆盖同一片区域、互不重叠的矩形。
 *
 * 按所有上下边把区域切成横条，每条内合并相交的水平区间；上下相邻且左右边相同的矩形再接成一个。
 * 用来把一张已经混合好的图分块画回去：每个像素只能画一次，否则半透明部分会叠加两遍。
 */
export function disjointCover(rects: readonly CoverRect[]): CoverRect[] {
  const valid = rects.filter(rect => rect.right > rect.left && rect.bottom > rect.top)
  const edges = [
    ...new Set(valid.flatMap(rect => [rect.top, rect.bottom])),
  ].sort((a, b) => a - b)
  const cover: CoverRect[] = []
  /** 上一条里的矩形，按左边排列，用于和当前条纵向合并。 */
  let previous: CoverRect[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const top = edges[i]!
    const bottom = edges[i + 1]!
    const spans = valid
      .filter(rect => rect.top < bottom && rect.bottom > top)
      .map(rect => [rect.left, rect.right] as [number, number])
      .sort((a, b) => a[0] - b[0])
    const current: CoverRect[] = []
    for (const [left, right] of spans) {
      const last = current[current.length - 1]
      if (last && left <= last.right)
        last.right = Math.max(last.right, right)
      else
        current.push({ left, top, right, bottom })
    }
    const merged = current.map((rect) => {
      const above = previous.find(other => other.bottom === top && other.left === rect.left && other.right === rect.right)
      if (!above)
        return rect
      above.bottom = bottom
      return above
    })
    for (const rect of merged) {
      if (!cover.includes(rect))
        cover.push(rect)
    }
    previous = merged
  }
  return cover
}
