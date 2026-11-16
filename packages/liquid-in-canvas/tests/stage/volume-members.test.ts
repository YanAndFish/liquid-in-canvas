import { describe, expect, it } from 'vitest'
import { MEMBER_PROXIMITY, memberCornered, writeFusionProximity } from '../../src/liquid-glass/volume-members.hot'
import { VOLUME_MEMBER_FLOATS } from '../../src/liquid-glass/volume-shader'

interface Member {
  x: number
  y: number
  halfWidth: number
  halfHeight: number
  radius?: number
  halfDepth: number
  elevation?: number
  fusion?: number
  bevel?: number
}

/** 按 `Member` 的布局写几名成员，返回 uniform 数组。 */
function members(list: Member[]): Float32Array {
  const data = new Float32Array(list.length * VOLUME_MEMBER_FLOATS)
  list.forEach((member, i) => {
    const offset = i * VOLUME_MEMBER_FLOATS
    data[offset] = member.x
    data[offset + 1] = member.y
    data[offset + 2] = member.halfWidth
    data[offset + 3] = member.halfHeight
    data.fill(member.radius ?? 28, offset + 4, offset + 8)
    data[offset + 8] = member.halfDepth
    data[offset + 9] = member.elevation ?? 16
    data[offset + 10] = member.fusion ?? 32
    data[offset + 24] = member.bevel ?? member.halfDepth * 0.8
  })
  return data
}

const proximity = (data: Float32Array, i: number): number => data[i * VOLUME_MEMBER_FLOATS + MEMBER_PROXIMITY]!

describe('融合成员的接近程度', () => {
  /** 200 × 200 的厚方块，与下方间距 `gap` 的 64 像素圆形调参按钮。 */
  const pair = (gap: number): Float32Array => members([
    {
      x: 180,
      y: 160,
      halfWidth: 100,
      halfHeight: 100,
      halfDepth: 60,
    },
    {
      x: 133,
      y: 260 + gap + 32,
      halfWidth: 32,
      halfHeight: 32,
      radius: 32,
      halfDepth: 19.2,
      fusion: 40,
    },
  ])

  it('只写给顶面较高的成员：刚分进同一组时为 0，贴在一起时为 1，中间平滑变化', () => {
    const values = [40, 32, 24, 16, 8, 0, -10].map((gap) => {
      const data = pair(gap)
      writeFusionProximity(data, 0, 2)
      // 较薄的圆形没有更薄的成员可以让给。
      expect(proximity(data, 1)).toBe(0)
      return proximity(data, 0)
    })
    // 间距不小于两者较小的融合距离（32）时为 0：分组前后画面不跳变。
    expect(values[0]).toBe(0)
    expect(values[1]).toBe(0)
    expect(values[3]).toBeCloseTo(0.5)
    expect(values[5]).toBe(1)
    expect(values[6]).toBe(1)
    for (let i = 1; i < values.length; i++)
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
  })

  it('次序与着色器的 fusion_order() 相同：顶面一样高时下标大的算较厚', () => {
    const data = members([
      {
        x: 100,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 20,
      },
      {
        x: 200,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 20,
      },
    ])
    writeFusionProximity(data, 0, 2)
    expect(proximity(data, 0)).toBe(0)
    expect(proximity(data, 1)).toBe(1)
  })

  it('底面高度也算进顶面；任意一方不融合时为 0', () => {
    const raised = members([
      {
        x: 100,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 30,
      },
      {
        x: 200,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 20,
        elevation: 40,
      },
    ])
    writeFusionProximity(raised, 0, 2)
    expect(proximity(raised, 0)).toBe(0)
    expect(proximity(raised, 1)).toBe(1)

    const apart = members([
      {
        x: 100,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 20,
      },
      {
        x: 200,
        y: 100,
        halfWidth: 50,
        halfHeight: 50,
        halfDepth: 30,
        fusion: 0,
      },
    ])
    writeFusionProximity(apart, 0, 2)
    expect(proximity(apart, 1)).toBe(0)
  })

  it('取与各个较薄成员的最大值', () => {
    // 厚方块两侧各有一个较薄的圆形：右边隔着 18 像素，左边隔着 14 像素；两个圆形相距很远。
    const data = members([
      {
        x: 0,
        y: 0,
        halfWidth: 100,
        halfHeight: 100,
        halfDepth: 60,
      },
      {
        x: 150,
        y: 0,
        halfWidth: 32,
        halfHeight: 32,
        halfDepth: 19,
      },
      {
        x: -146,
        y: 0,
        halfWidth: 32,
        halfHeight: 32,
        halfDepth: 18,
      },
    ])
    writeFusionProximity(data, 0, 3)
    const near = proximity(data, 0)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(1)
    expect(proximity(data, 1)).toBe(0)
    expect(proximity(data, 2)).toBe(0)
    // 右边的圆形贴上来之后取它的 1。
    data[VOLUME_MEMBER_FLOATS] = 132
    writeFusionProximity(data, 0, 3)
    expect(proximity(data, 0)).toBe(1)
  })
})

describe('拐角里截面查表不准确的成员', () => {
  it('圆角比倒角窄时成立，包括直角；胶囊与圆角不比倒角窄的矩形不成立', () => {
    const cornered = (radius: number, bevel: number, halfWidth = 100, halfHeight = 100): boolean =>
      memberCornered(members([
        {
          x: 0,
          y: 0,
          halfWidth,
          halfHeight,
          radius,
          halfDepth: 60,
          bevel,
        },
      ]), 0)
    expect(cornered(28, 48)).toBe(true)
    expect(cornered(0, 48)).toBe(true)
    expect(cornered(48, 48)).toBe(false)
    expect(cornered(48.2, 48.5)).toBe(false)
    expect(cornered(60, 48)).toBe(false)
    // 胶囊：圆角就是短边的一半，倒角不超过它。
    expect(cornered(999, 18, 146, 38)).toBe(false)
    // 倒角按短边的一半限制：短边 40 的控件倒角最多 20。
    expect(cornered(24, 48, 100, 20)).toBe(false)
  })

  it('任意一个拐角比倒角窄就成立', () => {
    const data = members([
      {
        x: 0,
        y: 0,
        halfWidth: 100,
        halfHeight: 100,
        radius: 60,
        halfDepth: 60,
        bevel: 48,
      },
    ])
    expect(memberCornered(data, 0)).toBe(false)
    data[6] = 12
    expect(memberCornered(data, 0)).toBe(true)
  })
})
