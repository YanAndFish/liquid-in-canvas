import type { StageResolution } from './types'

/**
 * 缺省的分辨率限制：画布倍率不超过 3、不限制总像素，文字按设备倍率绘制；
 * 玻璃着色倍率不超过 2；帧率不足时自动降级，但不降低画布倍率：文字清晰度是底线，
 * 需要时由接入方用 `minPixelRatio` 显式允许。
 */
export const DEFAULT_STAGE_RESOLUTION: Readonly<StageResolution> = Object.freeze({
  maxPixelRatio: 3,
  maxPixels: Infinity,
  maxGlassPixelRatio: 2,
  adaptive: true,
  minPixelRatio: Infinity,
})

interface PixelRatioInput {
  devicePixelRatio: number
  cssWidth: number
  cssHeight: number
  resolution: Pick<StageResolution, 'maxPixelRatio' | 'maxPixels'>
}

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

export function resolveCanvasScaleFloor(devicePixelRatio: number, pixelRatio: number, minPixelRatio: number): number {
  const device = devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  const floor = minPixelRatio >= 0
    ? Math.max(Math.min(1, device), minPixelRatio)
    : Infinity
  return pixelRatio > floor
    ? floor / pixelRatio
    : 1
}

export function resolveGlassPixelRatio(pixelRatio: number, maxGlassPixelRatio: number, adaptive: number): number {
  const cap = Number.isFinite(maxGlassPixelRatio) && maxGlassPixelRatio > 0
    ? maxGlassPixelRatio
    : pixelRatio
  return Math.min(pixelRatio, cap) * adaptive
}
