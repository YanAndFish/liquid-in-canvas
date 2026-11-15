import type { StageResolution } from '../../src/types'
import { describe, expect, it } from 'vitest'
import { AdaptiveScale } from '../../src/adaptive.hot'
import { resolveGlassPixelRatio, resolvePixelRatio } from '../../src/resolution'

const open: StageResolution = {
  maxPixelRatio: 3,
  maxPixels: Infinity,
  maxGlassPixelRatio: 2,
  adaptive: false,
}

function ratio(devicePixelRatio: number, resolution: Partial<StageResolution> = {}): number {
  return resolvePixelRatio({
    devicePixelRatio,
    cssWidth: 1000,
    cssHeight: 1000,
    resolution: {
      ...open,
      ...resolution,
    },
  })
}

/** 以固定间隔连续绘制，返回期间缩放变化的次数。`continuous` 为 false 时每次绘制之前都空过显示帧。 */
function run(adaptive: AdaptiveScale, clock: { now: number }, interval: number, frames: number, continuous = true): number {
  let changes = 0
  for (let i = 0; i < frames; i++) {
    clock.now += interval
    if (adaptive.sample(clock.now, continuous))
      changes++
  }
  return changes
}

describe('渲染倍率', () => {
  it('不超过设备倍率和上限', () => {
    expect(ratio(2)).toBe(2)
    expect(ratio(3, { maxPixelRatio: 2 })).toBe(2)
    expect(ratio(1.5, { maxPixelRatio: 2 })).toBe(1.5)
  })

  it('按像素预算缩小', () => {
    // 1000 × 1000 CSS 像素、预算 225 万像素时倍率为 1.5。
    expect(ratio(3, { maxPixels: 2_250_000 })).toBeCloseTo(1.5)
  })

  it('不会低于 1，除非设备倍率本身更低', () => {
    expect(ratio(2, { maxPixels: 100 })).toBe(1)
    expect(ratio(2, { maxPixelRatio: 0.25 })).toBe(1)
    expect(ratio(0.8, { maxPixelRatio: 0.25 })).toBe(0.8)
  })
})

describe('玻璃着色倍率', () => {
  it('不超过画布倍率和上限', () => {
    expect(resolveGlassPixelRatio(3, 2, 1)).toBe(2)
    expect(resolveGlassPixelRatio(1.5, 2, 1)).toBe(1.5)
    expect(resolveGlassPixelRatio(2, Infinity, 1)).toBe(2)
  })

  it('自适应缩放只作用于玻璃', () => {
    expect(resolveGlassPixelRatio(2, 2, 0.5)).toBe(1)
    expect(resolveGlassPixelRatio(3, 2, 0.75)).toBeCloseTo(1.5)
    // 画布倍率不受自适应影响。
    expect(ratio(3)).toBe(3)
  })

  it('忽略无效的上限', () => {
    expect(resolveGlassPixelRatio(2, 0, 1)).toBe(2)
    expect(resolveGlassPixelRatio(2, Number.NaN, 1)).toBe(2)
  })
})

describe('自适应缩放', () => {
  it('流畅时保持不变', () => {
    const adaptive = new AdaptiveScale()
    expect(run(adaptive, { now: 0 }, 16.7, 600)).toBe(0)
    expect(adaptive.scale).toBe(1)
  })

  it('持续变慢时逐级降低，但不低于下限', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.scale).toBeCloseTo(0.75)
    run(adaptive, clock, 28, 2000)
    expect(adaptive.scale).toBe(0.5)
  })

  it('只持续一个窗口的变慢不会触发调整', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 16.7, 100)
    // 约一秒的动画期间掉帧，随后恢复。
    run(adaptive, clock, 28, 40)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.scale).toBe(1)
  })

  it('单次卡顿不会触发调整', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 16.7, 20)
    run(adaptive, clock, 60, 1)
    run(adaptive, clock, 16.7, 200)
    expect(adaptive.scale).toBe(1)
  })

  it('绘制中断后不把空闲时间算作慢帧', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    for (let i = 0; i < 100; i++)
      run(adaptive, clock, 500, 1)
    expect(adaptive.scale).toBe(1)
  })

  it('按视频帧节拍绘制时不降级', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const clock = { now: 0 }
    // 30 帧与 24 帧的视频：间隔 33 ms、42 ms，但每次绘制之前都空过显示帧。
    expect(run(adaptive, clock, 33.4, 3000, false)).toBe(0)
    expect(run(adaptive, clock, 41.7, 3000, false)).toBe(0)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(false)
  })

  it('按视频帧节拍绘制时保持已有的降级，不升回', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 一分多钟只有视频在驱动重绘：没有能说明流畅的间隔。
    expect(run(adaptive, clock, 33.4, 2000, false)).toBe(0)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 恢复逐显示帧的绘制后，仍需流畅约四秒才升回。
    run(adaptive, clock, 16.7, 150)
    expect(adaptive.scale).toBeCloseTo(0.75)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.scale).toBe(1)
  })

  it('夹在连续绘制之间的零星空帧不抹掉变慢的证据', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    // 每三次慢的连续绘制之后空一帧再画一次。
    for (let i = 0; i < 40; i++) {
      run(adaptive, clock, 28, 3)
      run(adaptive, clock, 45, 1, false)
    }
    expect(adaptive.scale).toBeLessThan(1)
  })

  it('一段视频节拍把前后两段变慢隔开，各自不足以降级', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    for (let i = 0; i < 6; i++) {
      // 不到一个窗口的掉帧，随后只有视频在驱动重绘。
      run(adaptive, clock, 28, 40)
      run(adaptive, clock, 33.4, 30, false)
    }
    expect(adaptive.scale).toBe(1)
  })

  it('恢复流畅一段时间后升回', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 流畅不足四秒时不升。
    run(adaptive, clock, 16.7, 150)
    expect(adaptive.scale).toBeCloseTo(0.75)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.scale).toBe(1)
  })

  it('升回后再次变慢时推迟下一次尝试', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    run(adaptive, clock, 16.7, 400)
    expect(adaptive.scale).toBe(1)
    // 升回后不久又变慢，视为失败。
    run(adaptive, clock, 28, 90)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 第一次等待约四秒即可升回，这一次需要约八秒。
    run(adaptive, clock, 16.7, 400)
    expect(adaptive.scale).toBeCloseTo(0.75)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.scale).toBe(1)
  })

  it('调整后忽略重建绘制目标造成的卡顿帧', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 降级后紧跟的几帧仍然偏慢，随后恢复流畅：不应继续降级。
    run(adaptive, clock, 40, 8)
    run(adaptive, clock, 16.7, 200)
    expect(adaptive.scale).toBeCloseTo(0.75)
  })

  it('光路可以降级时先降光路，再降着色倍率；升回时顺序相反', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBe(1)
    // 改用查表后仍然跟不上，才开始降低着色倍率。
    run(adaptive, clock, 28, 120)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 恢复流畅：先升回着色倍率，光路仍是查表。
    run(adaptive, clock, 16.7, 450)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(true)
    run(adaptive, clock, 16.7, 450)
    expect(adaptive.relaxed).toBe(false)
  })

  it('改用查表后恢复流畅时不再降低着色倍率', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    run(adaptive, clock, 16.7, 100)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBe(1)
  })

  it('升回光路后再次变慢时推迟下一次尝试', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    run(adaptive, clock, 16.7, 400)
    expect(adaptive.relaxed).toBe(false)
    run(adaptive, clock, 28, 90)
    expect(adaptive.relaxed).toBe(true)
    run(adaptive, clock, 16.7, 400)
    expect(adaptive.relaxed).toBe(true)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.relaxed).toBe(false)
  })

  it('光路不能降级时直接降低着色倍率；改为不能降级时撤销光路降级', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 28, 90)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.scale).toBeCloseTo(0.75)
    adaptive.reset()
    adaptive.setRelaxable(true)
    // 重置后的第一帧只用来记下时间，多画几帧凑满两个窗口。
    run(adaptive, clock, 28, 100)
    expect(adaptive.relaxed).toBe(true)
    adaptive.setRelaxable(false)
    expect(adaptive.relaxed).toBe(false)
  })

  it('重置后回到初始状态', () => {
    const adaptive = new AdaptiveScale()
    run(adaptive, { now: 0 }, 28, 200)
    adaptive.reset()
    expect(adaptive.scale).toBe(1)
  })
})
