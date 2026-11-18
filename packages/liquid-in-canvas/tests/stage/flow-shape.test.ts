import type { FlowRect, FlowTaper } from '../../src/liquid-glass/flow.hot'
import { describe, expect, it } from 'vitest'
import { LiquidFlow, overshootDamping } from '../../src/liquid-glass/flow.hot'

interface Box {
  x: number
  y: number
  halfWidth: number
  halfHeight: number
  radius: number
}

type Field = (x: number, y: number) => number

function boxOf(rect: FlowRect, radius: number): Box {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    halfWidth: rect.width / 2,
    halfHeight: rect.height / 2,
    radius: Math.min(radius, rect.width / 2, rect.height / 2),
  }
}

function outline(box: Box): Field {
  return (x, y) => {
    const qx = Math.abs(x - box.x) - box.halfWidth + box.radius
    const qy = Math.abs(y - box.y) - box.halfHeight + box.radius
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - box.radius
  }
}

function taperField(taper: FlowTaper): Field {
  const { startX, startY, startRadius: ra, endX, endY, endRadius: rb } = taper
  const extent = Math.hypot(endX - startX, endY - startY)
  return (x, y) => {
    if (extent <= Math.abs(ra - rb) + 0.001) {
      return ra >= rb
        ? Math.hypot(x - startX, y - startY) - ra
        : Math.hypot(x - endX, y - endY) - rb
    }
    const alongX = (endX - startX) / extent
    const alongY = (endY - startY) / extent
    const px = x - startX
    const py = y - startY
    const u = px * alongX + py * alongY
    const v = Math.abs(-px * alongY + py * alongX)
    const sine = (ra - rb) / extent
    const cosine = Math.sqrt(1 - sine * sine)
    const k = u * cosine - v * sine
    if (k < 0)
      return Math.hypot(px, py) - ra
    if (k > extent * cosine)
      return Math.hypot(x - endX, y - endY) - rb
    return v * cosine + u * sine - ra
  }
}

function fused(body: Field, tail: Field, fusion: number): Field {
  const k = Math.max(fusion * 2, 0.001)
  return (x, y) => {
    const distance = body(x, y)
    const other = tail(x, y)
    const h = Math.min(1, Math.max(0, 0.5 + 0.5 * (other - distance) / k))
    return other + (distance - other) * h - k * h * (1 - h)
  }
}

interface Sampled {
  across: number
  profile: Map<number, number>
}

function sample(field: Field, bounds: FlowRect, centerX: number, centerY: number, unitX: number, unitY: number): Sampled {
  let low = Infinity
  let high = -Infinity
  const profile = new Map<number, [number, number]>()
  for (let x = bounds.left - 4; x <= bounds.left + bounds.width + 4; x += 0.5) {
    for (let y = bounds.top - 4; y <= bounds.top + bounds.height + 4; y += 0.5) {
      if (field(x, y) > 0)
        continue
      const across = (x - centerX) * -unitY + (y - centerY) * unitX
      const along = Math.round((x - centerX) * unitX + (y - centerY) * unitY)
      low = Math.min(low, across)
      high = Math.max(high, across)
      const slice = profile.get(along) ?? [Infinity, -Infinity]
      profile.set(along, [
        Math.min(slice[0], across),
        Math.max(slice[1], across),
      ])
    }
  }
  const widths = new Map<number, number>()
  for (const [along, [a, b]] of profile)
    widths.set(along, b - a)
  return { across: high - low, profile: widths }
}

function union(a: FlowRect, b: FlowRect): FlowRect {
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  }
}

interface Run {
  widest: number
  rest: number
  tailFrames: number
  necked: number
}

function migrate(start: FlowRect, target: FlowRect, radius: number, configure: (flow: LiquidFlow) => void): Run {
  const flow = new LiquidFlow(start)
  configure(flow)
  flow.retarget(target)
  const dx = target.left - start.left
  const dy = target.top - start.top
  const length = Math.hypot(dx, dy)
  const unitX = dx / length
  const unitY = dy / length
  const rest = sample(outline(boxOf(start, radius)), start, start.left + start.width / 2, start.top + start.height / 2, unitX, unitY).across
  const body = { left: 0, top: 0, width: 0, height: 0 }
  const tail = { left: 0, top: 0, width: 0, height: 0 }
  const taper = {
    startX: 0,
    startY: 0,
    startRadius: 0,
    endX: 0,
    endY: 0,
    endRadius: 0,
  }
  let widest = 0
  let tailFrames = 0
  let necked = 0
  for (let frame = 0; frame < 240 && flow.active; frame += 1) {
    flow.advance(1 / 120)
    if (frame % 3 !== 0)
      continue
    flow.rect(body)
    const centerX = body.left + body.width / 2
    const centerY = body.top + body.height / 2
    const box = outline(boxOf(body, radius))
    if (!flow.tail(tail, taper)) {
      widest = Math.max(widest, sample(box, body, centerX, centerY, unitX, unitY).across)
      continue
    }
    tailFrames++
    const shape = sample(fused(box, taperField(taper), flow.tailFusion()), union(body, tail), centerX, centerY, unitX, unitY)
    widest = Math.max(widest, shape.across)
    const behind = [
      ...shape.profile.entries(),
    ].filter(([along]) => along <= 0).sort((a, b) => b[0] - a[0])
    let narrowest = Infinity
    for (const [, width] of behind) {
      necked = Math.max(necked, width - narrowest)
      narrowest = Math.min(narrowest, width)
    }
  }
  return { widest, rest, tailFrames, necked }
}

describe('液体迁移的形状', () => {
  it('横向跳到别处时，本体与液滴拖尾融合后的轮廓不比静止时粗，向后单调收细', () => {
    const button = {
      left: 0,
      top: 0,
      width: 102,
      height: 44,
    }
    const result = migrate(button, { ...button, left: 306 }, 22, flow => flow.configure(1, 0.4, 0.1, 22))
    expect(result.tailFrames).toBeGreaterThan(3)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1.5)
    expect(result.necked).toBeLessThanOrEqual(1.5)
  })

  it('斜向跳到别处时，融合后的轮廓垂直于运动方向不比静止时粗，向后单调收细', () => {
    const square = {
      left: 0,
      top: 0,
      width: 64,
      height: 64,
    }
    const result = migrate(square, { ...square, left: 240, top: 180 }, 26, flow => flow.configure(2, 1, 1, 26))
    expect(result.tailFrames).toBeGreaterThan(3)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1.5)
    expect(result.necked).toBeLessThanOrEqual(1.5)
  })

  it('接近横向但略带斜度时，拖尾不让轮廓变粗', () => {
    const button = {
      left: 0,
      top: 0,
      width: 102,
      height: 44,
    }
    const result = migrate(button, { ...button, left: 300, top: 40 }, 22, flow => flow.configure(2, 0.4, 0.4, 22))
    expect(result.tailFrames).toBeGreaterThan(3)
    expect(result.widest).toBeLessThanOrEqual(result.rest + 1.5)
    expect(result.necked).toBeLessThanOrEqual(1.5)
  })

  it('拖尾从本体里的大圆收细到尾尖：越长尾尖越细，根部始终在本体之内', () => {
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
    const taper = {
      startX: 0,
      startY: 0,
      startRadius: 0,
      endX: 0,
      endY: 0,
      endRadius: 0,
    }
    const samples: { length: number, tip: number }[] = []
    for (let frame = 0; frame < 120 && flow.active; frame++) {
      flow.advance(1 / 120)
      flow.rect(body)
      if (!flow.tail(tail, taper))
        continue
      expect(taper.endRadius).toBeLessThan(taper.startRadius)
      expect(taper.endX).toBeLessThan(taper.startX)
      expect(outline(boxOf(body, 22))(taper.startX, taper.startY) + taper.startRadius).toBeLessThanOrEqual(1e-3)
      samples.push({ length: taper.startX - taper.endX, tip: taper.endRadius })
    }
    const longest = samples.reduce((a, b) => b.length > a.length
      ? b
      : a)
    const shortest = samples.reduce((a, b) => b.length < a.length
      ? b
      : a)
    expect(longest.length).toBeGreaterThan(shortest.length * 1.5)
    expect(longest.tip).toBeLessThan(shortest.tip)
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

describe('拖尾的粘性', () => {
  const drag = (speed: number, frames: number) => {
    const flow = new LiquidFlow({
      left: 0,
      top: 0,
      width: 64,
      height: 64,
    })
    flow.configure(1, 0.4, 0.1, 26)
    let left = 0
    for (let frame = 0; frame < frames; frame++) {
      if (frame % 2 === 0) {
        left += speed / 60
        flow.retarget({ left, top: 0, width: 64, height: 64 })
      }
      flow.advance(1 / 120)
    }
    return { flow, left }
  }

  it('匀速拖动时拖尾紧跟本体，尾尖不细于根部的一半', () => {
    const { flow } = drag(600, 60)
    const body = { left: 0, top: 0, width: 0, height: 0 }
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    const taper = {
      startX: 0,
      startY: 0,
      startRadius: 0,
      endX: 0,
      endY: 0,
      endRadius: 0,
    }
    flow.rect(body)
    expect(flow.tail(tail, taper)).toBe(true)
    const lag = body.left + body.width / 2 - taper.endX
    expect(lag).toBeGreaterThan(0)
    expect(lag / 600).toBeLessThan(0.075)
    expect(taper.endRadius).toBeGreaterThanOrEqual(taper.startRadius * 0.5 - 1e-6)
  })

  it('骤然停下后，越过本体的尾尖只是一个圆钝的小鼓包', () => {
    const { flow, left } = drag(1500, 40)
    const body = { left: 0, top: 0, width: 0, height: 0 }
    const tail = { left: 0, top: 0, width: 0, height: 0 }
    const taper = {
      startX: 0,
      startY: 0,
      startRadius: 0,
      endX: 0,
      endY: 0,
      endRadius: 0,
    }
    let bulge = 0
    let aheadFrames = 0
    for (let frame = 0; frame < 240 && flow.active; frame++) {
      flow.advance(1 / 120)
      flow.rect(body)
      if (!flow.tail(tail, taper))
        continue
      const front = body.left + body.width
      if (taper.endX > body.left + body.width / 2) {
        aheadFrames++
        bulge = Math.max(bulge, taper.endX + taper.endRadius - front)
        expect(taper.endRadius).toBeGreaterThan(taper.startRadius * 0.75)
      }
    }
    expect(left).toBeGreaterThan(400)
    expect(aheadFrames).toBeGreaterThan(0)
    expect(bulge).toBeLessThan(28 * 0.15 + 1)
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
    expect(settleTime(2)).toBeLessThan(normal * 0.65)
    expect(settleTime(0.5)).toBeGreaterThan(normal * 1.5)
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
