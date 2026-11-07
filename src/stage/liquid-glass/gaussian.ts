/** 各级高斯模糊的标准差，单位为 CSS 像素。 */
export const BLUR_SIGMAS = [2, 6, 16, 40, 80] as const

/** 一维高斯卷积核的采样点。 */
export interface GaussianTap {
  /** 距中心的偏移，以标准差为单位。 */
  offset: number
  /** 归一化后的权重，所有采样点的权重之和为 1。 */
  weight: number
}

/** 生成覆盖正负三倍标准差的对称高斯核。 */
export function gaussianKernel(): GaussianTap[] {
  const taps = Array.from({ length: 25 }, (_, index) => {
    const offset = (index - 12) / 4
    return {
      offset,
      weight: Math.exp(-offset * offset / 2),
    }
  })
  const sum = taps.reduce((total, tap) => total + tap.weight, 0)
  return taps.map(tap => ({ ...tap, weight: tap.weight / sum }))
}

/** 计算叠加到上一级所需的标准差，使卷积后的方差达到目标值。 */
export function incrementalSigma(previous: number, target: number): number {
  return Math.sqrt(Math.max(0, target * target - previous * previous))
}
