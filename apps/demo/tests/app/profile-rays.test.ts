import { glassProfile, glassProfileOutline } from 'liquid-in-canvas'
import { describe, expect, it } from 'vitest'
import { traceProfileRays } from '@/components/tuner/profile-rays'

const MATERIAL = {
  refraction: 24,
  bevelWidth: 0.68,
  bevelHeight: 0.68,
  bevelCurve: 3,
  bottomBevel: 1,
}

describe('截面光路', () => {
  const profile = glassProfile(MATERIAL)
  const outline = glassProfileOutline(profile, 16, 80)

  it('平面部分的光线笔直穿过', () => {
    const [ray] = traceProfileRays(outline, [40], 90)
    expect(ray!.landing).toBeCloseTo(40)
    expect(ray!.points).toHaveLength(4)
  })

  it('倒角上的光线被折向内部，越靠近轮廓偏得越多', () => {
    const [outer, inner] = traceProfileRays(outline, [2, 10], 90)
    expect(outer!.landing).not.toBeNull()
    expect(inner!.landing).not.toBeNull()
    expect(outer!.landing! - 2).toBeGreaterThan(inner!.landing! - 10)
    expect(inner!.landing!).toBeGreaterThan(10)
  })

  it('直线斜面的光线也能追踪到背景', () => {
    const chamfer = glassProfileOutline(glassProfile({ ...MATERIAL, bevelCurve: 1 }), 16, 80)
    for (const ray of traceProfileRays(chamfer, [1, 5, 9, 13], 90))
      expect(ray.points.length).toBeGreaterThanOrEqual(3)
  })
})
