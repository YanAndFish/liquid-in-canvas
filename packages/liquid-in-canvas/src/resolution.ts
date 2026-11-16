import type { StageResolution } from './types'

/**
 * 缺省的分辨率限制：画布倍率不超过 3、不限制总像素，文字按设备倍率绘制；
 * 玻璃着色倍率不超过 2；帧率不足时自动降级，画布倍率最低降到 1。
 */
export const DEFAULT_STAGE_RESOLUTION: Readonly<StageResolution> = Object.freeze({
  maxPixelRatio: 3,
  maxPixels: Infinity,
  maxGlassPixelRatio: 2,
  adaptive: true,
  minPixelRatio: 1,
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
 * 自适应降级可以把画布倍率乘到多小：`pixelRatio` 是 `resolvePixelRatio()` 的结果，返回 0 到 1 的系数下限。
 *
 * 降级后的倍率不低于 `minPixelRatio`，也不低于 1 与设备倍率中的较小值；
 * 画布倍率本来就不高于这个下限时返回 1，表示不能再降。
 */
export function resolveCanvasScaleFloor(devicePixelRatio: number, pixelRatio: number, minPixelRatio: number): number {
  const device = devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  // 无效的下限（NaN）按不允许降低处理。
  const floor = minPixelRatio >= 0
    ? Math.max(Math.min(1, device), minPixelRatio)
    : Infinity
  return pixelRatio > floor
    ? floor / pixelRatio
    : 1
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
