import type { NumberSink } from './fusion.hot'
import { CORNER_MARGIN, VOLUME_MEMBER_FLOATS } from './volume-shader'

/** 成员在 uniform 里的“与较薄成员的接近程度”（`Member.extra.w`）相对成员起点的位置。 */
export const MEMBER_PROXIMITY = 31

/**
 * 与 `glass_corner` 相同：成员是否有圆角比倒角窄 `CORNER_MARGIN` 以上，拐角里有截面查表不准确的一带。
 * `offset` 指向成员的起点。
 */
export function memberCornered(data: NumberSink, offset: number): boolean {
  const narrow = Math.min(data[offset + 2]!, data[offset + 3]!)
  const bevel = Math.min(data[offset + 24]!, narrow)
  for (let k = 0; k < 4; k++) {
    if (Math.min(data[offset + 4 + k]!, narrow) < bevel - CORNER_MARGIN)
      return true
  }
  return false
}

/** 成员顶面的高度（底面高度 + 厚度），按着色器里的单精度计算，与 `fusion_order()` 排出同样的次序。 */
function topOf(data: NumberSink, offset: number): number {
  return Math.fround(Math.fround(data[offset + 9]!) + Math.fround(2 * Math.fround(data[offset + 8]!)))
}

/**
 * 写入每名成员与顶面比它低的成员的接近程度（`Member.extra.w`），`members` 指向第一名成员。
 *
 * 着色器里较厚成员的截面参数与外观向轮廓外延伸的范围是“较小的融合距离 × (1 + 接近程度)”，见 `fuseDominance`。
 * 接近程度按两者矩形的间距算：间距不小于较小的融合距离（刚分进同一组）时为 0，贴在一起时为 1，
 * 成员靠近的过程中延伸范围连续变大，分组前后画面不跳变。取与各个较薄成员的最大值。
 */
export function writeFusionProximity(data: NumberSink, members: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = members + i * VOLUME_MEMBER_FLOATS
    const top = topOf(data, a)
    let proximity = 0
    for (let j = 0; j < count; j++) {
      if (j === i)
        continue
      const b = members + j * VOLUME_MEMBER_FLOATS
      const other = topOf(data, b)
      // 与 fusion_order() 相同的次序：顶面更低，或一样高且下标更小的成员排在前面。
      if (other > top || (other === top && j > i))
        continue
      const reach = Math.min(data[a + 10]!, data[b + 10]!)
      if (reach <= 0)
        continue
      const gapX = Math.max(Math.abs(data[a]! - data[b]!) - data[a + 2]! - data[b + 2]!, 0)
      const gapY = Math.max(Math.abs(data[a + 1]! - data[b + 1]!) - data[a + 3]! - data[b + 3]!, 0)
      const t = Math.min(1, Math.hypot(gapX, gapY) / reach)
      proximity = Math.max(proximity, 1 - t * t * (3 - 2 * t))
    }
    data[a + MEMBER_PROXIMITY] = proximity
  }
}
