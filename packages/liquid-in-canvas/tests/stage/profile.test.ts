import { describe, expect, it } from 'vitest'
import { glassEdgeTilt, glassProfile, glassProfileOutline } from '../../src/liquid-glass/profile'

const BASE = {
  refraction: 24,
  bevelWidth: 0.68,
  bevelHeight: 0.68,
  bevelCurve: 3,
  bottomBevel: 1,
}

describe('玻璃截面', () => {
  it('厚度受短边限制，倒角宽度不超过短边的一半，高度不超过半厚度', () => {
    expect(glassProfile(BASE).halfDepth).toBe(24)
    expect(glassProfile(BASE, 160, 44).halfDepth).toBeCloseTo(13.2)
    expect(glassProfile({ ...BASE, bevelWidth: 4 }, 160, 44).bevelWidth).toBe(22)
    expect(glassProfile({ ...BASE, bevelHeight: 1 }).bevelHeight).toBe(24)
  })

  it('倾斜程度在轮廓处为 1，向内递减，倒角以内为 0', () => {
    const tilt = (inset: number, power = 3): number => glassEdgeTilt(inset, 16, 16, power)
    expect(tilt(0)).toBe(1)
    expect(tilt(4)).toBeGreaterThan(tilt(8))
    expect(tilt(8)).toBeGreaterThan(tilt(14))
    expect(tilt(16)).toBe(0)
    // 指数为 1 时是直线斜面，坡度处处相同。
    expect(tilt(3, 1)).toBeCloseTo(tilt(12, 1))
    expect(tilt(3, 1)).toBeCloseTo(Math.SQRT1_2)
  })

  it('轮廓线从底面经侧面到顶面，端点落在倒角和平面的接合处', () => {
    const profile = glassProfile({ ...BASE, bevelHeight: 0.5, bottomBevel: 0.5 })
    const points = glassProfileOutline(profile, 10, 40, 8)
    expect(points[0]).toEqual([40, 10])
    expect(points.at(-1)).toEqual([40, 58])
    // 底面倒角结束在 (0, 10 + 6)，顶面倒角从 (0, 58 - 12) 开始，中间是竖直侧面。
    expect(points[1]![0]).toBeCloseTo(profile.bevelWidth / 2)
    expect(points[9]).toEqual([0, 16])
    expect(points[10]![0]).toBeCloseTo(0)
    expect(points[10]![1]).toBeCloseTo(46)
    expect(points.at(-2)![0]).toBeCloseTo(profile.bevelWidth)
  })
})
