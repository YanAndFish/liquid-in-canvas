export const BLUR_SIGMAS = [2, 6, 16, 40, 80] as const

export interface GaussianTap {
  offset: number
  weight: number
}

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

export function incrementalSigma(previous: number, target: number): number {
  return Math.sqrt(Math.max(0, target * target - previous * previous))
}
