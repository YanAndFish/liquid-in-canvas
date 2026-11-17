import { describe, expect, it } from 'vitest'
import { hexToLinear, srgbToLinear } from '../../src/liquid-glass/color'
import { LiquidFlow } from '../../src/liquid-glass/flow.hot'
import { GlassGroups } from '../../src/liquid-glass/fusion.hot'
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

function rectOf(flow: LiquidFlow) {
  const out = { left: 0, top: 0, width: 0, height: 0 }
  flow.rect(out)
  return out
}

function run(flow: LiquidFlow, seconds: number) {
  const frames = []
  for (let t = 0; t < seconds; t += 1 / 120) {
    flow.advance(1 / 120)
    frames.push(rectOf(flow))
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
    expect(rectOf(flow)).toEqual(TO)
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
    expect(rectOf(flow)).toEqual(TO)
  })

  it('拉伸为 0 时整体平移，不改变尺寸', () => {
    const flow = new LiquidFlow(FROM)
    flow.configure(0, 0, 0)
    flow.retarget(TO)
    const frames = run(flow, 2)
    expect(Math.max(...frames.map(rect => Math.abs(rect.width - 100)))).toBeLessThan(0.01)
    expect(Math.max(...frames.map(rect => rect.left))).toBeLessThanOrEqual(TO.left + 0.01)
    expect(flow.active).toBe(false)
  })

  it('回弹越大，前缘越过目标越多', () => {
    const overshoot = (bounce: number): number => {
      const flow = new LiquidFlow(FROM)
      flow.configure(1, bounce, 0)
      flow.retarget(TO)
      return Math.max(...run(flow, 2).map(rect => rect.left + rect.width)) - (TO.left + TO.width)
    }
    expect(overshoot(0)).toBeLessThan(0.5)
    expect(overshoot(1)).toBeGreaterThan(overshoot(0.33) + 5)
  })

  it('晃动使液滴到达后在压扁与拉长之间振荡，最后仍停在目标上', () => {
    const settled = (wobble: number) => {
      const flow = new LiquidFlow(FROM)
      flow.configure(1, 0.33, wobble)
      flow.retarget(TO)
      const late = run(flow, 3).slice(36)
      return {
        flow,
        narrowest: Math.min(...late.map(rect => rect.width)),
        widest: Math.max(...late.slice(48).map(rect => rect.width)),
      }
    }
    const calm = settled(0)
    const wobbly = settled(0.8)
    expect(calm.narrowest).toBeGreaterThan(99.9)
    expect(wobbly.narrowest).toBeLessThan(90)
    expect(wobbly.widest).toBeGreaterThan(103)
    expect(wobbly.flow.active).toBe(false)
    expect(rectOf(wobbly.flow)).toEqual(TO)
  })

  it('拖动时本体紧跟元素，拖尾沿斜向落在后面，松手后停在目标上', () => {
    const flow = new LiquidFlow({
      left: 600,
      top: 600,
      width: 64,
      height: 64,
    })
    flow.configure(1, 0.33, 0.35)
    const body = { left: 0, top: 0, width: 0, height: 0 }
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    let left = 600
    let top = 600
    let lag = 0
    let tailAngle = 0
    for (let frame = 0; frame < 60; frame++) {
      if (frame % 2 === 0) {
        left += 1500 / 60 * 0.6
        top -= 1500 / 60 * 0.8
        flow.retarget({ left, top, width: 64, height: 64 })
      }
      flow.advance(1 / 120)
      flow.rect(body)
      if (frame >= 30) {
        lag = Math.max(lag, Math.hypot(body.left - left, body.top - top))
        expect(body.width).toBeCloseTo(64, 0)
        expect(flow.tail(tail)).toBe(true)
        tailAngle = Math.atan2(tail.top + tail.height / 2 - body.top - 32, tail.left + tail.width / 2 - body.left - 32)
      }
    }
    expect(lag).toBeLessThan(20)
    expect(tailAngle).toBeCloseTo(Math.atan2(0.8, -0.6), 1)
    for (let frame = 0; frame < 360; frame++)
      flow.advance(1 / 120)
    expect(flow.active).toBe(false)
    expect(flow.tail(tail)).toBe(false)
    expect(rectOf(flow)).toEqual({ left, top, width: 64, height: 64 })
  })

  it('没有经过时间的帧不推进，也不产生 NaN', () => {
    const flow = new LiquidFlow(FROM)
    flow.configure(1, 0.33, 0.35)
    flow.retarget(TO)
    flow.advance(1 / 120)
    expect(flow.advance(0)).toBe(true)
    expect(flow.advance(-0.004)).toBe(true)
    run(flow, 3)
    expect(flow.active).toBe(false)
    expect(rectOf(flow)).toEqual(TO)
  })

  it('拖尾的融合距离随它离开本体逐渐增大，刚出现时不让玻璃鼓起', () => {
    const flow = new LiquidFlow({
      left: 0,
      top: 0,
      width: 64,
      height: 64,
    })
    flow.configure(1, 0.33, 0.35)
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    let left = 0
    const fusions: number[] = []
    for (let frame = 0; frame < 20; frame++) {
      left += 12
      flow.retarget({ left, top: 0, width: 64, height: 64 })
      flow.advance(1 / 60)
      if (flow.tail(tail))
        fusions.push(flow.tailFusion(40))
    }
    expect(fusions[0]).toBeLessThan(8)
    expect(fusions.at(-1)).toBeGreaterThan(fusions[0]! * 3)
    expect(Math.max(...fusions)).toBeLessThanOrEqual(40)
  })

  it('尺寸过渡期间报告 resizing，只移动位置时不报告', () => {
    const grow = new LiquidFlow({
      left: 240,
      top: 0,
      width: 52,
      height: 52,
    })
    grow.configure(1, 0.33, 0.35)
    grow.retarget({
      left: 0,
      top: 0,
      width: 292,
      height: 244,
    })
    grow.advance(1 / 60)
    expect(grow.resizing).toBe(true)
    run(grow, 3)
    expect(grow.resizing).toBe(false)

    const move = new LiquidFlow(FROM)
    move.retarget(TO)
    move.advance(1 / 60)
    expect(move.active).toBe(true)
    expect(move.resizing).toBe(false)
  })

  it('跳变（例如面板展开）时没有拖尾，只有连续跟随才拉出拖尾', () => {
    const flow = new LiquidFlow({
      left: 240,
      top: 0,
      width: 52,
      height: 52,
    })
    flow.configure(1, 0.33, 0.35)
    flow.retarget({
      left: 0,
      top: 0,
      width: 292,
      height: 244,
    })
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    for (let frame = 0; frame < 120; frame++) {
      flow.advance(1 / 120)
      expect(flow.tail(tail)).toBe(false)
    }
  })

  it('斜向移动时不整体放大，拉长交给落在后面的拖尾', () => {
    const square = {
      left: 0,
      top: 0,
      width: 200,
      height: 200,
    }
    const corner = {
      left: 400,
      top: 400,
      width: 200,
      height: 200,
    }
    const flow = new LiquidFlow(square)
    flow.configure(2, 0.1, 0.1)
    flow.retarget(corner)
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    let largest = 0
    let trailed = 0
    for (let frame = 0; frame < 240 && flow.active; frame++) {
      flow.advance(1 / 120)
      const body = rectOf(flow)
      largest = Math.max(largest, body.width * body.height)
      if (flow.tail(tail)) {
        const behind = (body.left + body.width / 2 - tail.left - tail.width / 2) + (body.top + body.height / 2 - tail.top - tail.height / 2)
        trailed = Math.max(trailed, behind)
        expect(tail.width).toBeCloseTo(tail.height, 0)
      }
    }
    expect(largest).toBeLessThan(200 * 200 * 1.25)
    expect(trailed).toBeGreaterThan(60)
    expect(rectOf(flow)).toEqual(corner)
  })

  it('斜向移动时圆形拖尾始终贴着圆角本体，不脱成单独的液滴', () => {
    const radius = 28
    const join = 32
    const flow = new LiquidFlow({
      left: 400,
      top: 0,
      width: 200,
      height: 200,
    })
    flow.configure(2, 0.1, 0.1, join, radius)
    flow.retarget({
      left: 0,
      top: 400,
      width: 200,
      height: 200,
    })
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    let widest = -Infinity
    let seen = 0
    for (let frame = 0; frame < 240 && flow.active; frame++) {
      flow.advance(1 / 120)
      if (!flow.tail(tail))
        continue
      seen++
      const body = rectOf(flow)
      const corner = Math.min(radius, body.width / 2, body.height / 2)
      const qx = Math.abs(tail.left + tail.width / 2 - body.left - body.width / 2) - body.width / 2 + corner
      const qy = Math.abs(tail.top + tail.height / 2 - body.top - body.height / 2) - body.height / 2 + corner
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner
      widest = Math.max(widest, outside - Math.min(tail.width, tail.height) / 2)
    }
    expect(seen).toBeGreaterThan(10)
    expect(widest).toBeLessThan(join * 0.2 + 2)
    expect(widest).toBeGreaterThan(-40)
  })

  it('跳到别处时拖尾留在出发点附近，被本体拉走后并回本体', () => {
    const flow = new LiquidFlow(FROM)
    flow.configure(1, 0.1, 0.1)
    flow.retarget(TO)
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    let seen = false
    for (let frame = 0; frame < 30; frame++) {
      flow.advance(1 / 120)
      if (flow.tail(tail)) {
        seen = true
        expect(tail.left + tail.width / 2).toBeLessThan(rectOf(flow).left + rectOf(flow).width / 2)
        expect(tail.width / tail.height).toBeCloseTo(100 / 40, 1)
      }
    }
    expect(seen).toBe(true)
    for (let frame = 0; frame < 600 && flow.active; frame++)
      flow.advance(1 / 120)
    expect(flow.tail(tail)).toBe(false)
  })

  it('进度从 0 增加到 1，静止与重新定位后都有定义', () => {
    const flow = new LiquidFlow(FROM)
    expect(flow.progress()).toBe(1)
    flow.retarget(TO)
    expect(flow.progress()).toBe(0)
    const values = [0]
    for (let frame = 0; frame < 600 && flow.active; frame++) {
      flow.advance(1 / 120)
      values.push(flow.progress())
    }
    expect(values.at(-1)).toBe(1)
    expect(values.some(value => value > 0.3 && value < 0.9)).toBe(true)
  })

  it('拉伸为 0 时没有拖尾', () => {
    const flow = new LiquidFlow(FROM)
    flow.configure(0, 0.33, 0.35)
    flow.retarget(TO)
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    for (let frame = 0; frame < 30; frame++) {
      flow.advance(1 / 120)
      expect(flow.tail(tail)).toBe(false)
    }
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
    expect(Math.abs(rectOf(slow).left - rectOf(fast).left)).toBeLessThan(2)
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
      layer: 0,
      host: null,
      clip: [0, 0, 1000, 1000],
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      materialize: 1,
      options,
      fusion: options.fusion,
    }
    const surfaces = [
      { ...base, id: 1, left: 0, width: 400 },
      { ...base, id: 2, left: 10, host: 1 },
      { ...base, id: 3, left: 120, host: 1 },
      { ...base, id: 4, left: 420 },
    ]
    const grouping = new GlassGroups()
    grouping.build(surfaces, surfaces.length)
    const groups = grouping.groups.slice(0, grouping.count).map(group => group.members.slice(0, group.count))
    expect(groups.map(group => group.map(surface => surface.id))).toEqual([
      [1, 4],
      [2, 3],
    ])
  })
})
