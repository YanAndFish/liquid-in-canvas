import type { StageResolution } from '../../src/types'
import { describe, expect, it } from 'vitest'
import { AdaptiveScale } from '../../src/adaptive.hot'
import { resolveCanvasScaleFloor, resolveGlassPixelRatio, resolvePixelRatio } from '../../src/resolution'

const open: StageResolution = {
  maxPixelRatio: 3,
  maxPixels: Infinity,
  maxGlassPixelRatio: 2,
  adaptive: false,
  minPixelRatio: 1,
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

/** 以固定间隔连续绘制，返回期间状态变化的次数。固定间隔意味着任何降级都不见效。 */
function run(adaptive: AdaptiveScale, clock: { now: number }, interval: number, frames: number): number {
  let changes = 0
  for (let i = 0; i < frames; i++) {
    clock.now += interval
    if (adaptive.sample(clock.now))
      changes++
  }
  return changes
}

/** 一帧里各部分的开销（毫秒）：与画布像素数成正比的、与玻璃着色像素数成正比的、不随降级变化的。 */
interface Load {
  canvas?: number
  glass?: number
  fixed?: number
  /** 光路没有降为查表时，玻璃着色开销乘以它。 */
  optics?: number
}

/** 按负载模型算出当前状态下的绘制间隔：跟得上时是 16.7 ms，跟不上时等于开销。 */
function intervalOf(adaptive: AdaptiveScale, load: Load): number {
  const optics = adaptive.relaxed
    ? 1
    : load.optics ?? 1
  const cost = (load.fixed ?? 0)
    + (load.canvas ?? 0) * adaptive.canvasScale ** 2
    + (load.glass ?? 0) * optics * adaptive.scale ** 2
  return Math.max(16.7, cost)
}

/** 按负载模型连续绘制：降级见效与否由模型决定。返回期间状态变化的次数。 */
function drive(adaptive: AdaptiveScale, clock: { now: number }, load: Load, frames: number): number {
  let changes = 0
  for (let i = 0; i < frames; i++) {
    clock.now += intervalOf(adaptive, load)
    if (adaptive.sample(clock.now))
      changes++
  }
  return changes
}

/** 连续绘制直到状态变化一次，返回用掉的帧数；`limit` 帧内没有变化时返回 -1。`load` 是数字时按固定间隔绘制。 */
function untilChange(adaptive: AdaptiveScale, clock: { now: number }, load: Load | number, limit = 20000): number {
  for (let i = 1; i <= limit; i++) {
    clock.now += typeof load === 'number'
      ? load
      : intervalOf(adaptive, load)
    if (adaptive.sample(clock.now))
      return i
  }
  return -1
}

/** 不画玻璃也跟不上的大画布：开销几乎全部与画布像素数成正比（33 MP 时 33 ms）。 */
const PIXEL_BOUND: Load = { fixed: 2, canvas: 31 }
/** 玻璃着色是瓶颈：逐步求交约为查表的三倍。 */
const GLASS_BOUND: Load = { fixed: 8, glass: 7, optics: 3 }

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

describe('画布倍率系数的下限', () => {
  it('降级后的倍率不低于配置的下限', () => {
    expect(resolveCanvasScaleFloor(3, 3, 1)).toBeCloseTo(1 / 3)
    expect(resolveCanvasScaleFloor(3, 3, 1.5)).toBeCloseTo(0.5)
    expect(resolveCanvasScaleFloor(3, 2, 1.5)).toBeCloseTo(0.75)
  })

  it('不低于 1 与设备倍率中的较小值', () => {
    expect(resolveCanvasScaleFloor(2, 2, 0)).toBeCloseTo(0.5)
    expect(resolveCanvasScaleFloor(2, 2, 0.25)).toBeCloseTo(0.5)
    // 设备倍率本身低于 1 时已经在下限上。
    expect(resolveCanvasScaleFloor(0.8, 0.8, 0)).toBe(1)
  })

  it('画布倍率不高于下限时不能再降', () => {
    expect(resolveCanvasScaleFloor(1, 1, 1)).toBe(1)
    expect(resolveCanvasScaleFloor(3, 1.5, 2)).toBe(1)
    expect(resolveCanvasScaleFloor(3, 3, Infinity)).toBe(1)
    expect(resolveCanvasScaleFloor(3, 3, Number.NaN)).toBe(1)
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
  })

  it('忽略无效的上限', () => {
    expect(resolveGlassPixelRatio(2, 0, 1)).toBe(2)
    expect(resolveGlassPixelRatio(2, Number.NaN, 1)).toBe(2)
  })
})

describe('自适应降级', () => {
  it('流畅时保持不变', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(0.5)
    expect(run(adaptive, { now: 0 }, 16.7, 600)).toBe(0)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.canvasScale).toBe(1)
  })

  it('见效但仍然偏慢时逐级降低着色倍率，但不低于下限', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    // 60 → 42.5 → 32.7 → 30 ms。
    const load: Load = { fixed: 20, glass: 40 }
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.75)
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.5625)
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBe(0.5)
    expect(drive(adaptive, clock, load, 2000)).toBe(0)
  })

  it('降到跟得上为止；见效但仍然偏慢时不必再等两个窗口', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    // 28 → 20.1 → 15.7 ms。
    const load: Load = { fixed: 10, glass: 18 }
    const first = untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.75)
    const second = untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.5625)
    expect(second).toBeLessThan(first)
    expect(drive(adaptive, clock, load, 200)).toBe(0)
  })

  it('只持续一个窗口的变慢不会触发调整', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    run(adaptive, clock, 16.7, 100)
    // 不到一秒的动画期间掉帧，随后恢复。
    run(adaptive, clock, 28, 30)
    expect(run(adaptive, clock, 16.7, 300)).toBe(0)
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
    expect(run(adaptive, clock, 500, 100)).toBe(0)
    expect(adaptive.scale).toBe(1)
  })

  it('帧很慢时窗口按时间结束，不必凑满帧数', () => {
    const adaptive = new AdaptiveScale()
    // 80 ms 一帧：两个约一秒的窗口后降级，而不是 90 帧（七秒多）。
    expect(untilChange(adaptive, { now: 0 }, 80)).toBeLessThan(30)
    // 跟得上时仍是 45 帧一个窗口，两个窗口后降级。
    const quick = new AdaptiveScale()
    expect(untilChange(quick, { now: 0 }, 20)).toBe(90)
  })

  it('恢复流畅一段时间后升回', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    untilChange(adaptive, clock, { fixed: 8, glass: 14 })
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 流畅不足四秒时不升。
    run(adaptive, clock, 16.7, 200)
    expect(adaptive.scale).toBeCloseTo(0.75)
    run(adaptive, clock, 16.7, 300)
    expect(adaptive.scale).toBe(1)
  })

  it('升回后再次变慢时撤回并推迟下一次尝试', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    // 1 → 22 ms，0.75 → 15.9 ms：降一级后流畅，升回必然失败。
    const load: Load = { fixed: 8, glass: 14 }
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.75)
    let lowered = clock.now
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBe(1)
    // 第一次等待约四秒即可升回。
    expect(clock.now - lowered).toBeGreaterThan(4000)
    expect(clock.now - lowered).toBeLessThan(6500)
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.75)
    lowered = clock.now
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBe(1)
    // 这一次需要约八秒。
    expect(clock.now - lowered).toBeGreaterThan(8000)
    expect(clock.now - lowered).toBeLessThan(10500)
  })

  it('调整后忽略重建绘制目标造成的卡顿帧', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    const load: Load = { fixed: 8, glass: 14 }
    untilChange(adaptive, clock, load)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 降级后紧跟的几帧仍然偏慢，随后恢复流畅：这一级算见效，也不应继续降级。
    run(adaptive, clock, 40, 8)
    expect(drive(adaptive, clock, load, 200)).toBe(0)
    expect(adaptive.scale).toBeCloseTo(0.75)
  })

  it('重置后回到初始状态', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(0.5)
    const clock = { now: 0 }
    // 110 ms 起步，每一级都见效，一直降到画布倍率。
    const load: Load = { canvas: 30, glass: 20, optics: 4 }
    for (let i = 0; i < 10 && adaptive.canvasScale === 1; i++)
      untilChange(adaptive, clock, load)
    expect(adaptive.canvasScale).toBeLessThan(1)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBeLessThan(1)
    adaptive.reset()
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.canvasScale).toBe(1)
  })
})

describe('降级的顺序', () => {
  it('光路可以降级时先降光路，再降着色倍率；升回时顺序相反', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    const clock = { now: 0 }
    // 逐步求交 44 ms，查表 26 ms，查表且 0.75 倍 18.1 ms。
    const load: Load = { fixed: 8, glass: 18, optics: 2 }
    untilChange(adaptive, clock, load)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBe(1)
    // 改用查表见效但仍然跟不上，才开始降低着色倍率。
    untilChange(adaptive, clock, load)
    expect(adaptive.relaxed).toBe(true)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 恢复流畅：先升回着色倍率，光路仍是查表。
    untilChange(adaptive, clock, 16.7)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(true)
    untilChange(adaptive, clock, 16.7)
    expect(adaptive.relaxed).toBe(false)
  })

  it('改用查表后恢复流畅时不再降低着色倍率，也不动画布倍率', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(0.5)
    const clock = { now: 0 }
    untilChange(adaptive, clock, GLASS_BOUND)
    expect(adaptive.relaxed).toBe(true)
    expect(drive(adaptive, clock, GLASS_BOUND, 200)).toBe(0)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.canvasScale).toBe(1)
  })

  it('升回光路后再次变慢时只撤回光路', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(0.5)
    const clock = { now: 0 }
    let toggles = 0
    let touched = false
    // 两分钟里光路几次升回又撤回，其余两种手段始终不动。
    while (clock.now < 120000) {
      untilChange(adaptive, clock, GLASS_BOUND)
      toggles++
      touched ||= adaptive.scale < 1 || adaptive.canvasScale < 1
    }
    expect(touched).toBe(false)
    // 降一次；四秒、八秒、十六秒、三十二秒后各升回一次并撤回；最后一次变化是六十四秒后的升回。
    expect(toggles).toBe(10)
  })

  it('光路不能降级时直接降低着色倍率；改为不能降级时撤销光路降级', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    untilChange(adaptive, clock, GLASS_BOUND)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.scale).toBeCloseTo(0.75)
    adaptive.reset()
    adaptive.setRelaxable(true)
    untilChange(adaptive, clock, GLASS_BOUND)
    expect(adaptive.relaxed).toBe(true)
    adaptive.setRelaxable(false)
    expect(adaptive.relaxed).toBe(false)
  })

  it('光路与着色倍率都用尽后才降低画布倍率，升回时先升画布倍率', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(1 / 3)
    const clock = { now: 0 }
    /** 推进到下一次变化，返回变化的是哪种手段。 */
    const step = (load: Load | number): string => {
      const relaxed = adaptive.relaxed
      const scale = adaptive.scale
      const canvasScale = adaptive.canvasScale
      if (untilChange(adaptive, clock, load, 3000) < 0)
        return 'none'
      if (adaptive.canvasScale !== canvasScale)
        return 'canvas'
      if (adaptive.scale !== scale)
        return 'glass'
      return adaptive.relaxed !== relaxed
        ? 'optics'
        : 'none'
    }
    // 每一级都见效，但要一直降到画布倍率才跟得上：
    // 102 → 62（查表）→ 44.5 → 34.7 → 32（着色倍率 0.5）→ 22（画布像素数 ×0.55）→ 19 ms，不快不慢，停在这一级。
    const load: Load = { canvas: 22, glass: 40, optics: 2 }
    const lowered: string[] = []
    for (let name = step(load); name !== 'none'; name = step(load))
      lowered.push(name)
    expect(lowered).toEqual([
      'optics',
      'glass',
      'glass',
      'glass',
      'canvas',
      'canvas',
    ])
    expect(adaptive.scale).toBe(0.5)
    // 第一级按超出的幅度多降一些，第二级是缺省的四分之一。
    expect(adaptive.canvasScale).toBeCloseTo(Math.sqrt(17.5 / 32 * 0.75))
    // 负载消失后按相反的顺序升回：画布倍率、着色倍率、光路。
    const raised: string[] = []
    for (let name = step(16.7); name !== 'none'; name = step(16.7)) {
      if (raised.at(-1) !== name)
        raised.push(name)
    }
    expect(raised).toEqual(['canvas', 'glass', 'optics'])
    expect(adaptive.canvasScale).toBe(1)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.relaxed).toBe(false)
  })
})

describe('见效判断', () => {
  it('降级后间隔没有缩短就撤回', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBeCloseTo(0.75)
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBe(1)
  })

  it('无效的手段在一段时间内不再尝试，之后的间隔加倍', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    untilChange(adaptive, clock, 28)
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBe(1)
    // 撤回后一直偏慢，约三十秒后才再试一次。
    let reverted = clock.now
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBeCloseTo(0.75)
    expect(clock.now - reverted).toBeGreaterThan(30000)
    expect(clock.now - reverted).toBeLessThan(33000)
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBe(1)
    // 仍然无效，下一次要等约六十秒。
    reverted = clock.now
    untilChange(adaptive, clock, 28)
    expect(clock.now - reverted).toBeGreaterThan(60000)
    expect(clock.now - reverted).toBeLessThan(63000)
  })

  it('改善不足一毫秒或不足百分之五都算无效', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    // 28 → 27.1 ms。
    const slight: Load = { fixed: 26, glass: 2 }
    untilChange(adaptive, clock, slight)
    expect(adaptive.scale).toBeCloseTo(0.75)
    untilChange(adaptive, clock, slight)
    expect(adaptive.scale).toBe(1)

    // 65 → 62.8 ms：缩短了两毫秒多，但间隔这么长时窗口之间的波动也有这么大。
    const noisy = new AdaptiveScale()
    const heavy: Load = { fixed: 60, glass: 5 }
    untilChange(noisy, clock, heavy)
    expect(noisy.scale).toBeCloseTo(0.75)
    untilChange(noisy, clock, heavy)
    expect(noisy.scale).toBe(1)
  })

  it('画布像素数是瓶颈时撤回光路与着色倍率，只降低画布倍率', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(1 / 3)
    const clock = { now: 0 }
    // 两个慢窗口后先试光路。
    untilChange(adaptive, clock, PIXEL_BOUND)
    expect(adaptive.relaxed).toBe(true)
    // 光路无效：撤回，同一帧里改试着色倍率。
    untilChange(adaptive, clock, PIXEL_BOUND)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 着色倍率也无效：撤回，同一帧里改降画布倍率。间隔是流畅时的近两倍，像素数一次减到 53%。
    untilChange(adaptive, clock, PIXEL_BOUND)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.canvasScale).toBeCloseTo(Math.sqrt(17.5 / 33))
    // 画布倍率见效（33 → 18.4 ms），不再继续降，玻璃的质量没有损失。
    expect(drive(adaptive, clock, PIXEL_BOUND, 1000)).toBe(0)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.scale).toBe(1)
  })

  it('画布倍率一级最多把像素数减半，最少减四分之一', () => {
    const heavy = new AdaptiveScale()
    heavy.setCanvasFloor(0.1)
    const clock = { now: 0 }
    // 80 ms：按比例要减到 22%，一级只减到一半。
    untilChange(heavy, clock, { canvas: 80 })
    untilChange(heavy, clock, { canvas: 80 })
    expect(heavy.canvasScale).toBeCloseTo(Math.sqrt(0.5))

    const mild = new AdaptiveScale()
    mild.setCanvasFloor(0.1)
    // 20 ms：按比例只要减到 88%，一级仍减四分之一。
    untilChange(mild, clock, { canvas: 20 })
    untilChange(mild, clock, { canvas: 20 })
    expect(mild.canvasScale).toBeCloseTo(Math.sqrt(0.75))
  })

  it('画布倍率不低于下限；下限为 1 时不改变画布倍率', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setCanvasFloor(0.8)
    const clock = { now: 0 }
    let lowest = 1
    for (let i = 0; i < 3000; i++) {
      drive(adaptive, clock, PIXEL_BOUND, 1)
      lowest = Math.min(lowest, adaptive.canvasScale)
    }
    expect(lowest).toBeCloseTo(0.8)
    expect(adaptive.canvasScale).toBeCloseTo(0.8)

    const fixed = new AdaptiveScale()
    for (let i = 0; i < 3000; i++) {
      drive(fixed, clock, PIXEL_BOUND, 1)
      lowest = Math.min(lowest, fixed.canvasScale)
    }
    expect(fixed.canvasScale).toBe(1)
    expect(lowest).toBeCloseTo(0.8)
  })

  it('下限抬高时把已经降低的画布倍率抬到下限', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setCanvasFloor(0.5)
    drive(adaptive, { now: 0 }, PIXEL_BOUND, 1000)
    expect(adaptive.canvasScale).toBeCloseTo(Math.sqrt(17.5 / 33))
    adaptive.setCanvasFloor(0.9)
    expect(adaptive.canvasScale).toBeCloseTo(0.9)
    adaptive.setCanvasFloor(1)
    expect(adaptive.canvasScale).toBe(1)
  })

  it('画布倍率升回失败时只撤回画布倍率，不重新试其余手段', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setRelaxable(true)
    adaptive.setCanvasFloor(1 / 3)
    const clock = { now: 0 }
    // 1 → 22 ms，0.87 → 16.5 ms：降一级后流畅，升回必然失败。
    const load: Load = { canvas: 22 }
    for (let i = 0; i < 10 && adaptive.canvasScale === 1; i++)
      untilChange(adaptive, clock, load)
    expect(adaptive.relaxed).toBe(false)
    expect(adaptive.scale).toBe(1)
    expect(adaptive.canvasScale).toBeCloseTo(Math.sqrt(0.75))
    // 之后的五十秒里画布倍率几次升回又撤回，光路与着色倍率始终不动。
    const end = clock.now + 50000
    let touched = false
    let raised = 0
    while (clock.now < end) {
      const before = adaptive.canvasScale
      drive(adaptive, clock, load, 1)
      touched ||= adaptive.relaxed || adaptive.scale < 1
      if (adaptive.canvasScale > before)
        raised++
    }
    expect(touched).toBe(false)
    // 四秒、八秒、十六秒后各试一次，下一次要等三十二秒。
    expect(raised).toBe(3)
  })

  it('最后一小级不见效时撤回它，换下一种手段', () => {
    const adaptive = new AdaptiveScale()
    adaptive.setCanvasFloor(1 / 3)
    const clock = { now: 0 }
    // 着色倍率 0.5625 → 0.5 只省 0.8 ms，不算见效；之后降低画布倍率。
    const load: Load = { canvas: 24, glass: 12 }
    drive(adaptive, clock, load, 500)
    expect(adaptive.scale).toBeCloseTo(0.5625)
    expect(adaptive.canvasScale).toBeLessThan(1)
  })

  it('绘制中断不会丢掉正在进行的检验', () => {
    const adaptive = new AdaptiveScale()
    const clock = { now: 0 }
    untilChange(adaptive, clock, 28)
    expect(adaptive.scale).toBeCloseTo(0.75)
    // 检验到一半页面静止了一秒，恢复绘制后重新凑满一个窗口再判断。
    expect(run(adaptive, clock, 28, 25)).toBe(0)
    run(adaptive, clock, 1000, 1)
    expect(untilChange(adaptive, clock, 28)).toBeGreaterThan(30)
    expect(adaptive.scale).toBe(1)
  })
})
