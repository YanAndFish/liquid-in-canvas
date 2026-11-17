import type { FlowRect } from '../../src/liquid-glass/flow.hot'
import { describe, expect, it } from 'vitest'
import { LiquidFlow, overshootDamping } from '../../src/liquid-glass/flow.hot'

interface Box {
  x: number
  y: number
  halfWidth: number
  halfHeight: number
  radius: number
}

function boxOf(rect: FlowRect, radius: number): Box {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    halfWidth: rect.width / 2,
    halfHeight: rect.height / 2,
    radius: Math.min(radius, rect.width / 2, rect.height / 2),
  }
}

function outline(box: Box, x: number, y: number): number {
  const qx = Math.abs(x - box.x) - box.halfWidth + box.radius
  const qy = Math.abs(y - box.y) - box.halfHeight + box.radius
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - box.radius
}

function fused(body: Box, tail: Box, fusion: number, x: number, y: number): number {
  const distance = outline(body, x, y)
  const other = outline(tail, x, y)
  const k = Math.max(fusion * 2, 0.001)
  const h = Math.min(1, Math.max(0, 0.5 + 0.5 * (other - distance) / k))
  return other + (distance - other) * h - k * h * (1 - h)
}

function thickness(body: Box, tail: Box | null, fusion: number, unitX: number, unitY: number): number {
  const normalX = -unitY
  const normalY = unitX
  let low = Infinity
  let high = -Infinity
  const left = Math.min(body.x - body.halfWidth, tail
    ? tail.x - tail.halfWidth
    : Infinity) - fusion - 2
  const right = Math.max(body.x + body.halfWidth, tail
    ? tail.x + tail.halfWidth
    : -Infinity) + fusion + 2
  const top = Math.min(body.y - body.halfHeight, tail
    ? tail.y - tail.halfHeight
    : Infinity) - fusion - 2
  const bottom = Math.max(body.y + body.halfHeight, tail
    ? tail.y + tail.halfHeight
    : -Infinity) + fusion + 2
  for (let x = left; x <= right; x += 0.5) {
    for (let y = top; y <= bottom; y += 0.5) {
      const inside = tail
        ? fused(body, tail, fusion, x, y)
        : outline(body, x, y)
      if (inside > 0)
        continue
      const across = (x - body.x) * normalX + (y - body.y) * normalY
      low = Math.min(low, across)
      high = Math.max(high, across)
    }
  }
  return high - low
}

function widest(start: FlowRect, target: FlowRect, radius: number, configure: (flow: LiquidFlow) => void, fusionLimit = 32): { widest: number, rest: number, tailFrames: number } {
  const flow = new LiquidFlow(start)
  configure(flow)
  flow.retarget(target)
  const dx = target.left - start.left
  const dy = target.top - start.top
  const length = Math.hypot(dx, dy)
  const unitX = dx / length
  const unitY = dy / length
  const rest = thickness(boxOf(start, radius), null, 0, unitX, unitY)
  const body = { left: 0, top: 0, width: 0, height: 0 }
  const tail = { left: 0, top: 0, width: 0, height: 0 }
  let most = 0
  let tailFrames = 0
  for (let frame = 0; frame < 240 && flow.active; frame += 1) {
    flow.advance(1 / 120)
    if (frame % 3 !== 0)
      continue
    flow.rect(body)
    const hasTail = flow.tail(tail)
    if (hasTail)
      tailFrames++
    const width = thickness(boxOf(body, radius), hasTail
      ? {
          ...boxOf(tail, Infinity),
        }
      : null, hasTail
      ? flow.tailFusion(fusionLimit)
      : 0, unitX, unitY)
    most = Math.max(most, width)
  }
  return { widest: most, rest, tailFrames }
}

describe('液体迁移的形状', () => {
  it('横向跳到别处时，本体与拖尾融合后的轮廓不比静止时粗', () => {
    const button = {
      left: 0,
      top: 0,
      width: 102,
      height: 44,
    }
    const result = widest(button, { ...button, left: 306 }, 22, flow => flow.configure(1, 0.4, 0.1, 22))
    expect(result.tailFrames).toBeGreaterThan(5)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1)
  })

  it('斜向跳到别处时，融合后的轮廓垂直于运动方向不比静止时粗', () => {
    const square = {
      left: 0,
      top: 0,
      width: 64,
      height: 64,
    }
    const result = widest(square, { ...square, left: 240, top: 180 }, 26, flow => flow.configure(2, 1, 1, 26))
    expect(result.tailFrames).toBeGreaterThan(5)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1)
  })

  it('接近横向但略带斜度时，拖尾的延伸不让轮廓变粗', () => {
    const button = {
      left: 0,
      top: 0,
      width: 102,
      height: 44,
    }
    const result = widest(button, { ...button, left: 300, top: 40 }, 22, flow => flow.configure(2, 0.4, 0.4, 22))
    expect(result.tailFrames).toBeGreaterThan(5)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1)
  })

  it('横向拖尾是变细变长的胶囊：越长越细，且比本体细', () => {
    const flow = new LiquidFlow({
      left: 0,
      top: 0,
      width: 102,
      height: 44,
    })
    flow.configure(1, 0.4, 0.1, 22)
    flow.retarget({
      left: 306,
      top: 0,
      width: 102,
      height: 44,
    })
    const body = { left: 0, top: 0, width: 0, height: 0 }
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    const samples: { length: number, height: number }[] = []
    for (let frame = 0; frame < 120 && flow.active; frame++) {
      flow.advance(1 / 120)
      flow.rect(body)
      if (!flow.tail(tail))
        continue
      expect(tail.height).toBeLessThan(body.height)
      expect(tail.width).toBeGreaterThanOrEqual(tail.height)
      samples.push({ length: tail.width, height: tail.height })
    }
    const longest = samples.reduce((a, b) => b.length > a.length
      ? b
      : a)
    const shortest = samples.reduce((a, b) => b.length < a.length
      ? b
      : a)
    expect(longest.length).toBeGreaterThan(shortest.length * 1.5)
    expect(longest.height).toBeLessThan(shortest.height)
  })

  it('迁移期间本体垂直于运动方向的尺寸不超过静止尺寸', () => {
    const flow = new LiquidFlow({
      left: 0,
      top: 0,
      width: 100,
      height: 40,
    })
    flow.configure(1, 1, 1)
    flow.retarget({
      left: 300,
      top: 0,
      width: 100,
      height: 40,
    })
    const body = { left: 0, top: 0, width: 0, height: 0 }
    for (let frame = 0; frame < 480 && flow.active; frame++) {
      flow.advance(1 / 120)
      flow.rect(body)
      expect(body.height).toBeLessThanOrEqual(40 + 1e-6)
    }
  })
})

describe('迁移速度与回弹', () => {
  const settleTime = (speed: number): number => {
    const flow = new LiquidFlow({
      left: 0,
      top: 0,
      width: 100,
      height: 40,
    })
    flow.configure(1, 0.4, 0.1, 0, speed)
    flow.retarget({
      left: 300,
      top: 0,
      width: 100,
      height: 40,
    })
    let time = 0
    while (flow.active && time < 10) {
      flow.advance(1 / 240)
      time += 1 / 240
    }
    return time
  }

  it('速度为 2 时大约用一半的时间停下', () => {
    const normal = settleTime(1)
    const fast = settleTime(2)
    const slow = settleTime(0.5)
    expect(fast).toBeLessThan(normal * 0.65)
    expect(slow).toBeGreaterThan(normal * 1.5)
  })

  it('速度不改变回弹的幅度', () => {
    const overshoot = (speed: number): number => {
      const flow = new LiquidFlow({
        left: 0,
        top: 0,
        width: 100,
        height: 40,
      })
      flow.configure(1, 0.4, 0, 0, speed)
      flow.retarget({
        left: 300,
        top: 0,
        width: 100,
        height: 40,
      })
      const body = { left: 0, top: 0, width: 0, height: 0 }
      let most = 0
      for (let frame = 0; frame < 2400 && flow.active; frame++) {
        flow.advance(1 / 480)
        flow.rect(body)
        most = Math.max(most, body.left + body.width - 400)
      }
      return most
    }
    expect(Math.abs(overshoot(2) - overshoot(1))).toBeLessThan(overshoot(1) * 0.1)
    expect(overshoot(1)).toBeGreaterThan(8)
  })

  it('回弹按越过距离线性换算阻尼比', () => {
    expect(overshootDamping(0)).toBe(1)
    const ratio = overshootDamping(0.1)
    expect(Math.exp(-Math.PI * ratio / Math.sqrt(1 - ratio * ratio))).toBeCloseTo(0.1, 6)
  })

  it('非法速度回到 1', () => {
    expect(settleTime(Number.NaN)).toBeCloseTo(settleTime(1), 6)
  })
})
