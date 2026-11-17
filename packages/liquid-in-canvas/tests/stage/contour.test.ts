import type { ContourSample } from '../helpers/corner-field'
import { describe, expect, it } from 'vitest'
import { cornerReach, glassContour } from '../helpers/corner-field'

const HALF_WIDTH = 228
const HALF_HEIGHT = 148
const RADIUS = 28
const BEVEL = 64
const REACH = cornerReach(RADIUS, BEVEL, Math.min(HALF_WIDTH, HALF_HEIGHT))
const out: ContourSample = { distance: 0, normalX: 0, normalY: 0 }

type Field = (x: number, y: number) => number

const depthAt: Field = (x, y) => -glassContour(Math.abs(x) - HALF_WIDTH + RADIUS, Math.abs(y) - HALF_HEIGHT + RADIUS, RADIUS, REACH, BEVEL, out).distance
const exactDepth: Field = (x, y) => -glassContour(Math.abs(x) - HALF_WIDTH + RADIUS, Math.abs(y) - HALF_HEIGHT + RADIUS, RADIUS, 0, BEVEL, out).distance

const arcDepth: Field = (x, y) => {
  const wx = Math.abs(x) - HALF_WIDTH + RADIUS
  const wy = Math.abs(y) - HALF_HEIGHT + RADIUS
  const e = wx - wy
  return Math.abs(e) < RADIUS
    ? -0.5 * (Math.sqrt(2 * RADIUS * RADIUS - e * e) - wx - wy)
    : RADIUS - Math.max(wx, wy)
}

function gradient(field: Field, x: number, y: number): [number, number] {
  const h = 0.01
  return [
    (field(x + h, y) - field(x - h, y)) / (2 * h),
    (field(x, y + h) - field(x, y - h)) / (2 * h),
  ]
}

function roughness(field: Field, depth: number): number {
  const y = HALF_HEIGHT - depth
  const step = 0.5
  const magnitudes: number[] = []
  for (let x = HALF_WIDTH - 140; x < HALF_WIDTH - depth - 1; x += step)
    magnitudes.push(Math.hypot(...gradient(field, x, y)))
  let worst = 0
  for (let i = 1; i < magnitudes.length - 1; i++)
    worst = Math.max(worst, Math.abs(magnitudes[i + 1]! - 2 * magnitudes[i]! + magnitudes[i - 1]!))
  return worst
}

describe('轮廓距离场的拐角', () => {
  it('倒角宽于圆角时，轮廓本身仍是 CSS 圆角，外缘接近精确距离', () => {
    expect(REACH).toBeGreaterThan(0)
    const cx = HALF_WIDTH - RADIUS
    const cy = HALF_HEIGHT - RADIUS
    for (let i = 0; i <= 40; i++) {
      const angle = i / 40 * Math.PI / 2
      for (const offset of [-6, -2, 0]) {
        const x = cx + Math.cos(angle) * (RADIUS - offset)
        const y = cy + Math.sin(angle) * (RADIUS - offset)
        expect(depthAt(x, y)).toBeCloseTo(exactDepth(x, y), 6)
      }
      const x = cx + Math.cos(angle) * (RADIUS - 2)
      const y = cy + Math.sin(angle) * (RADIUS - 2)
      expect(Math.abs(depthAt(x, y) - exactDepth(x, y))).toBeLessThan(0.05)
    }
  })

  it('场在整个拐角里连续，梯度长度不超过 1', () => {
    const step = 0.5
    for (let y = HALF_HEIGHT - 120; y < HALF_HEIGHT; y += step) {
      for (let x = HALF_WIDTH - 120; x < HALF_WIDTH; x += step) {
        const here = depthAt(x, y)
        expect(Math.abs(depthAt(x + step, y) - here)).toBeLessThanOrEqual(step * 1.01)
        expect(Math.abs(depthAt(x, y + step) - here)).toBeLessThanOrEqual(step * 1.01)
      }
    }
  })

  it('等距线在直边与拐角的交界处曲率连续，梯度长度没有折点', () => {
    for (const depth of [8, 16, 24, 32, 40]) {
      const smooth = roughness(depthAt, depth)
      const creased = roughness(arcDepth, depth)
      expect(smooth).toBeLessThan(creased / 4)
    }
  })

  it('法线指向深度减小最快的方向', () => {
    for (const [x, y] of [
      [210, 130],
      [200, 125],
      [190, 120],
      [215, 110],
      [180, 140],
      [205, 100],
      [170, 100],
    ] as const) {
      glassContour(x - HALF_WIDTH + RADIUS, y - HALF_HEIGHT + RADIUS, RADIUS, REACH, BEVEL, out)
      const [gx, gy] = gradient(depthAt, x, y)
      const length = Math.hypot(gx, gy)
      expect(out.normalX).toBeCloseTo(-gx / length, 3)
      expect(out.normalY).toBeCloseTo(-gy / length, 3)
    }
  })

  it('倒角不比圆角宽时就是圆角矩形的精确距离', () => {
    expect(cornerReach(28, 30, 148)).toBe(0)
    expect(cornerReach(28, 64, 40)).toBe(12)
  })
})
