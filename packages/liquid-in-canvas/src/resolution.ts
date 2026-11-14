import type { StageResolution } from './types'

/**
 * 缺省的分辨率限制：画布倍率不超过 3、不限制总像素，文字按设备倍率绘制；
 * 玻璃着色倍率不超过 2，帧率不足时进一步降低。
 */
export const DEFAULT_STAGE_RESOLUTION: Readonly<StageResolution> = Object.freeze({
  maxPixelRatio: 3,
  maxPixels: Infinity,
  maxGlassPixelRatio: 2,
  adaptive: true,
})

interface PixelRatioInput {
  devicePixelRatio: number
  cssWidth: number
  cssHeight: number
  resolution: Pick<StageResolution, 'maxPixelRatio' | 'maxPixels'>
}

/**
 * 计算画布的渲染倍率。
 *
 * 依次应用倍率上限和像素预算。结果不低于 1 与设备倍率中的较小值，
 * 避免文字比普通显示器上的页面更模糊。
 */
export function resolvePixelRatio(input: PixelRatioInput): number {
  const device = input.devicePixelRatio > 0
    ? input.devicePixelRatio
    : 1
  const floor = Math.min(1, device)
  const cap = Math.max(floor, input.resolution.maxPixelRatio)
  let ratio = Math.min(device, cap)
  const area = input.cssWidth * input.cssHeight
  if (area > 0 && Number.isFinite(input.resolution.maxPixels) && input.resolution.maxPixels > 0)
    ratio = Math.min(ratio, Math.sqrt(input.resolution.maxPixels / area))
  return Math.max(floor, ratio)
}

/**
 * 计算玻璃体积的着色倍率：不超过画布倍率和配置的上限，再乘以自适应缩放。
 *
 * 结果除以画布倍率就是体积着色相对画布的缩放比例。
 */
export function resolveGlassPixelRatio(pixelRatio: number, maxGlassPixelRatio: number, adaptive: number): number {
  const cap = Number.isFinite(maxGlassPixelRatio) && maxGlassPixelRatio > 0
    ? maxGlassPixelRatio
    : pixelRatio
  return Math.min(pixelRatio, cap) * adaptive
}
