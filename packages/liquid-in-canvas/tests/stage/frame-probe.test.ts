import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdaptiveScale } from '../../src/adaptive.hot'
import { FrameProbe } from '../../src/frame-probe.hot'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number

/** 一个显示帧里先触发 `requestAnimationFrame` 回调，这与 Chrome 里 `paint` 事件之前的顺序一致。 */
function displayFrame(): void {
  const due = Array.from(frames.values())
  frames.clear()
  for (const callback of due)
    callback(0)
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('显示帧探针', () => {
  it('每个显示帧都绘制时是连续的', () => {
    const probe = new FrameProbe()
    probe.mark()
    for (let i = 0; i < 10; i++) {
      displayFrame()
      expect(probe.mark()).toBe(true)
    }
  })

  it('中间空过显示帧的绘制不是连续的', () => {
    const probe = new FrameProbe()
    probe.mark()
    // 每两个显示帧绘制一次：30 帧的视频在 60 Hz 的屏幕上。
    for (let i = 0; i < 10; i++) {
      displayFrame()
      displayFrame()
      expect(probe.mark()).toBe(false)
    }
    // 之后恢复逐帧绘制，从第二次开始算连续。
    displayFrame()
    expect(probe.mark()).toBe(true)
  })

  it('空过多个显示帧也一样', () => {
    const probe = new FrameProbe()
    probe.mark()
    for (let i = 0; i < 5; i++)
      displayFrame()
    expect(probe.mark()).toBe(false)
  })

  it('同一帧里绘制先于回调时结果相同', () => {
    const probe = new FrameProbe()
    // 每一帧先绘制、后触发回调。
    probe.mark()
    displayFrame()
    expect(probe.mark()).toBe(true)
    displayFrame()
    // 空一帧。
    displayFrame()
    expect(probe.mark()).toBe(false)
    displayFrame()
    expect(probe.mark()).toBe(true)
  })

  it('绘制停止后数到两帧就不再请求回调', () => {
    const probe = new FrameProbe()
    probe.mark()
    expect(frames.size).toBe(1)
    displayFrame()
    expect(frames.size).toBe(1)
    displayFrame()
    expect(frames.size).toBe(0)
    // 下一次绘制重新开始计数。
    expect(probe.mark()).toBe(false)
    expect(frames.size).toBe(1)
  })

  it('连续绘制期间只保留一个待触发的回调', () => {
    const probe = new FrameProbe()
    for (let i = 0; i < 5; i++) {
      probe.mark()
      expect(frames.size).toBe(1)
      displayFrame()
    }
  })

  it('停止后取消回调，下一次绘制不算连续', () => {
    const probe = new FrameProbe()
    probe.mark()
    probe.stop()
    expect(frames.size).toBe(0)
    expect(probe.mark()).toBe(false)
  })
})

describe('显示帧探针与自适应降级', () => {
  /** 按给定的显示帧间隔推进；`paints(frame)` 决定这一帧是否绘制。返回质量变化的次数。 */
  function simulate(
    adaptive: AdaptiveScale,
    probe: FrameProbe,
    clock: { now: number },
    interval: number,
    count: number,
    paints: (frame: number) => boolean,
  ): number {
    let changes = 0
    for (let frame = 0; frame < count; frame++) {
      clock.now += interval
      displayFrame()
      if (paints(frame) && adaptive.sample(clock.now, probe.mark()))
        changes++
    }
    return changes
  }

  it('同样是 33 ms 的绘制间隔：按视频帧绘制不降级，跟不上显示器才降级', () => {
    // 60 Hz 的屏幕、30 帧的视频：每隔一个显示帧绘制一次。
    const paced = new AdaptiveScale()
    paced.setRelaxable(true)
    expect(simulate(paced, new FrameProbe(), { now: 0 }, 16.7, 2400, frame => frame % 2 === 0)).toBe(0)
    expect(paced.scale).toBe(1)
    expect(paced.relaxed).toBe(false)

    // 浏览器每 33 ms 才出一帧，每一帧都在绘制：滚动或动画跟不上。
    const slow = new AdaptiveScale()
    slow.setRelaxable(true)
    expect(simulate(slow, new FrameProbe(), { now: 0 }, 33.4, 400, () => true)).toBeGreaterThan(0)
    expect(slow.relaxed).toBe(true)
    expect(slow.scale).toBeLessThan(1)
  })

  it('24 帧的视频与时快时慢的视频帧都不降级', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const probe = new FrameProbe()
    const clock = { now: 0 }
    // 24 帧：间隔在两个与三个显示帧之间交替。
    expect(simulate(adaptive, probe, clock, 16.7, 2000, frame => frame % 5 === 0 || frame % 5 === 2)).toBe(0)
    // 回调抖动：偶尔连着两个显示帧都有新的视频帧，随后空两帧。
    expect(simulate(adaptive, probe, clock, 16.7, 2000, frame => frame % 6 === 0 || frame % 6 === 1 || frame % 6 === 4)).toBe(0)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(false)
  })

  it('播放视频的同时滚动：逐显示帧取样，跟不上时照常降级，流畅后升回', () => {
    const adaptive = new AdaptiveScale()
    const probe = new FrameProbe()
    const clock = { now: 0 }
    simulate(adaptive, probe, clock, 16.7, 600, frame => frame % 2 === 0)
    // 开始滚动，每一帧都绘制，浏览器 28 ms 才出一帧。
    simulate(adaptive, probe, clock, 28, 120, () => true)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 停止滚动、只剩视频：不再降，也不凭视频节拍升回。
    expect(simulate(adaptive, probe, clock, 16.7, 2400, frame => frame % 2 === 0)).toBe(0)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 再次滚动且流畅，四秒后升回。
    simulate(adaptive, probe, clock, 16.7, 400, () => true)
    expect(adaptive.scale).toBe(1)
  })
})
