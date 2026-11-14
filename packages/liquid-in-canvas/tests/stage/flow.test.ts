import { describe, expect, it } from 'vitest'
import { hexToLinear, srgbToLinear } from '../../src/liquid-glass/color'
import { LiquidFlow } from '../../src/liquid-glass/flow'
import { groupGlassSurfaces } from '../../src/liquid-glass/fusion'
import { parseGlassOptions } from '../../src/liquid-glass/options'

const FROM = {
  left: 0,
  top: 0,
  width: 100,
  height: 40,
}
const TO = {
  left: 300,
  top: 0,
  width: 100,
  height: 40,
}

/** 以 120 Hz 推进，返回每帧的矩形。 */
function run(flow: LiquidFlow, seconds: number) {
  const frames = []
  for (let t = 0; t < seconds; t += 1 / 120) {
    flow.advance(1 / 120)
    frames.push(flow.rect())
  }
  return frames
}

describe('液体迁移', () => {
  it('朝运动方向拉长并收窄，最后停在目标上', () => {
    const flow = new LiquidFlow(FROM)
    expect(flow.retarget(TO)).toBe(true)
    const frames = run(flow, 2)
    const widest = Math.max(...frames.map(rect => rect.width))
    const thinnest = Math.min(...frames.map(rect => rect.height))
    expect(widest).toBeGreaterThan(160)
    expect(thinnest).toBeLessThan(40)
    expect(flow.active).toBe(false)
    expect(flow.rect()).toEqual(TO)
  })

  it('前缘先到，尾部被拖在后面', () => {
    const flow = new LiquidFlow(FROM)
    flow.retarget(TO)
    const early = run(flow, 0.12).at(-1)!
    const lead = early.left + early.width - (FROM.left + FROM.width)
    const tail = early.left - FROM.left
    expect(lead).toBeGreaterThan(tail * 1.5)
  })

  it('目标不变时不重新开始运动，`snap()` 直接到位', () => {
    const flow = new LiquidFlow(FROM)
    expect(flow.retarget(FROM)).toBe(false)
    expect(flow.advance(1 / 60)).toBe(false)
    flow.retarget(TO)
    flow.snap(TO)
    expect(flow.active).toBe(false)
    expect(flow.rect()).toEqual(TO)
  })

  it('30 Hz 与 120 Hz 下的轨迹接近', () => {
    const slow = new LiquidFlow(FROM)
    const fast = new LiquidFlow(FROM)
    slow.retarget(TO)
    fast.retarget(TO)
    for (let i = 0; i < 6; i++)
      slow.advance(1 / 30)
    for (let i = 0; i < 24; i++)
      fast.advance(1 / 120)
    expect(Math.abs(slow.rect().left - fast.rect().left)).toBeLessThan(2)
  })
})

describe('颜色换算', () => {
  it('sRGB 分量按标准曲线解码到线性值', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1)
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3)
    expect(hexToLinear('#ff8000')).toEqual([
      1,
      srgbToLinear(128 / 255),
      0,
    ].map(v => expect.closeTo(v, 6)))
  })
})

describe('嵌套玻璃的融合', () => {
  it('嵌套玻璃不与自己的外层融合，只与同一外层里的嵌套玻璃融合', () => {
    const options = parseGlassOptions(document.createElement('div'), 'light')
    const base = {
      top: 0,
      height: 40,
      width: 100,
      clip: [0, 0, 1000, 1000] as const,
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      options,
    }
    const groups = groupGlassSurfaces([
      { ...base, id: 1, left: 0, width: 400 },
      { ...base, id: 2, left: 10, host: 1 },
      { ...base, id: 3, left: 120, host: 1 },
      { ...base, id: 4, left: 420 },
    ])
    expect(groups.map(group => group.map(surface => surface.id))).toEqual([
      [1, 4],
      [2, 3],
    ])
  })
})
