import type { NumberSink } from './fusion.hot'
import { CORNER_MARGIN, VOLUME_MEMBER_FLOATS } from './volume-shader'

export const MEMBER_PROXIMITY = 31

export function memberCornered(data: NumberSink, offset: number): boolean {
  const narrow = Math.min(data[offset + 2]!, data[offset + 3]!)
  const bevel = Math.min(data[offset + 24]!, narrow)
  for (let k = 0; k < 4; k++) {
    if (Math.min(data[offset + 4 + k]!, narrow) < bevel - CORNER_MARGIN)
      return true
  }
  return false
}

function topOf(data: NumberSink, offset: number): number {
  return Math.fround(Math.fround(data[offset + 9]!) + Math.fround(2 * Math.fround(data[offset + 8]!)))
}

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
