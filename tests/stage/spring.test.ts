import { describe, expect, it } from 'vitest'
import { advanceSpring } from '@/stage/liquid-glass/spring'

/** 推进一秒，模拟不同屏幕刷新率下的按压响应。 */
function simulate(rate: number) {
  const state = { value: 0, velocity: 0 }
  for (let i = 0; i < rate; i++)
    advanceSpring(state, 1, 1 / rate)
  return state
}

describe('玻璃交互弹簧', () => {
  it('不同刷新率下都能在一秒内停在目标位置', () => {
    for (const rate of [30, 60, 120]) {
      const state = simulate(rate)
      expect(state.value).toBe(1)
      expect(state.velocity).toBe(0)
    }
  })

  it('动画途中反向时从当前位置返回', () => {
    const state = { value: 0, velocity: 0 }
    for (let i = 0; i < 6; i++)
      advanceSpring(state, 1, 1 / 60)
    const before = state.value
    advanceSpring(state, 0, 1 / 60)
    expect(Math.abs(state.value - before)).toBeLessThan(0.15)
    for (let i = 0; i < 120; i++)
      advanceSpring(state, 0, 1 / 60)
    expect(state.value).toBe(0)
    expect(state.velocity).toBe(0)
  })

  it('后台恢复产生的大时间间隔不会让控件跳出目标范围', () => {
    const state = { value: 0, velocity: 0 }
    advanceSpring(state, 1, 30)
    expect(state.value).toBeGreaterThan(0)
    expect(state.value).toBeLessThan(1)
    expect(Number.isFinite(state.velocity)).toBe(true)
  })
})
