import { describe, expect, it } from 'vitest'
import { BLUR_SIGMAS, gaussianKernel, incrementalSigma } from '../../src/liquid-glass/gaussian'

describe('高斯背景卷积', () => {
  it('均匀背景通过卷积后保持亮度', () => {
    const result = gaussianKernel().reduce((sum, tap) => sum + 0.42 * tap.weight, 0)
    expect(result).toBeCloseTo(0.42, 10)
  })

  it('单个亮点向两侧等量扩散且中心最亮', () => {
    const kernel = gaussianKernel()
    const center = Math.floor(kernel.length / 2)
    for (let index = 0; index < center; index++) {
      expect(kernel[index]!.weight).toBe(kernel[kernel.length - index - 1]!.weight)
      expect(kernel[index]!.weight).toBeLessThan(kernel[index + 1]!.weight)
    }
    const variance = kernel.reduce((sum, tap) => sum + tap.offset ** 2 * tap.weight, 0)
    expect(variance).toBeGreaterThan(0.97)
    expect(variance).toBeLessThanOrEqual(1)
  })

  it('逐级卷积的累计方差达到各级目标值', () => {
    let variance = 0
    let previous = 0
    for (const sigma of BLUR_SIGMAS) {
      variance += incrementalSigma(previous, sigma) ** 2
      expect(Math.sqrt(variance)).toBeCloseTo(sigma, 10)
      previous = sigma
    }
  })
})
