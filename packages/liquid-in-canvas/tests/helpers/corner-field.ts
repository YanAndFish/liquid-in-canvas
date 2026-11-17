import { CORNER_EASE, CORNER_REACH, CORNER_SQUARE } from '../../src/liquid-glass/contour'

export interface ContourSample {
  distance: number
  normalX: number
  normalY: number
}

export function cornerReach(radius: number, bevel: number, narrow: number): number {
  return Math.min(Math.max(bevel * CORNER_REACH - radius, 0), narrow - radius)
}

export function glassContour(qx: number, qy: number, radius: number, reach: number, bevel: number, out: ContourSample): ContourSample {
  const px = Math.max(qx, 0)
  const py = Math.max(qy, 0)
  const length = Math.hypot(px, py)
  const g = Math.max(qx, qy)
  const exact = (g > 0
    ? length
    : g) - radius
  const innerX = qx > qy
    ? 1
    : 0
  const outwardX = g > 0
    ? px / Math.max(length, 0.00001)
    : innerX
  const outwardY = g > 0
    ? py / Math.max(length, 0.00001)
    : 1 - innerX
  const liftedX = qx + reach
  const liftedY = qy + reach
  if (reach <= 0 || exact >= 0 || liftedX <= 0 || liftedY <= 0) {
    out.distance = exact
    out.normalX = outwardX
    out.normalY = outwardY
    return out
  }
  const power = 2 + 2 * Math.min(reach / Math.max(radius * CORNER_SQUARE, 0.001), 1)
  const scale = Math.max(liftedX, liftedY)
  const unitX = liftedX / scale
  const unitY = liftedY / scale
  const sum = unitX ** power + unitY ** power
  const rounded = scale * sum ** (1 / power) - radius - reach
  const towardScale = sum ** ((power - 1) / power)
  const ease = bevel * CORNER_EASE
  const t = Math.min(-exact / ease, 1)
  const weight = t * t * t * (t * (t * 6 - 15) + 10)
  const slope = 30 * t * t * (1 - t) * (1 - t) / ease
  const nx = outwardX + (unitX ** (power - 1) / towardScale - outwardX) * weight - (rounded - exact) * slope * outwardX
  const ny = outwardY + (unitY ** (power - 1) / towardScale - outwardY) * weight - (rounded - exact) * slope * outwardY
  const normal = Math.max(Math.hypot(nx, ny), 0.00001)
  out.distance = exact + (rounded - exact) * weight
  out.normalX = nx / normal
  out.normalY = ny / normal
  return out
}
