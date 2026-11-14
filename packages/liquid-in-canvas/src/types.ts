export type StageCapability = 'html-in-canvas' | 'webgpu' | 'draw-element-image-to-texture'

export interface StageSupportReport {
  htmlInCanvas: boolean
  webgpu: boolean
  drawElementImageToTexture: boolean
  browser: string
}

export type StageSupport
  = | { supported: true, report: StageSupportReport, missing: readonly [] }
    | { supported: false, report: StageSupportReport, missing: readonly StageCapability[] }

export interface StageFault {
  kind: 'unsupported' | 'init' | 'runtime'
  support: StageSupport
  cause?: unknown
}

export interface StageMetrics {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  /** 画布的实际渲染倍率，也是页面文字的倍率；可能低于 `devicePixelRatio`。 */
  dpr: number
  /** 玻璃体积的实际着色倍率，不高于 `dpr`。 */
  glassDpr: number
}

/**
 * 渲染分辨率的限制。
 *
 * 画布分辨率决定整页文字的清晰度，只受 `maxPixelRatio` 与 `maxPixels` 这两个静态上限约束。
 * 玻璃体积的着色分辨率可以单独降低：玻璃后的背景本来就经过折射与模糊，降低它几乎不影响观感，
 * 页面文字和玻璃上的文字仍按画布分辨率绘制。
 */
export interface StageResolution {
  /** 画布渲染倍率上限。高于它的 `devicePixelRatio` 会被降到这个值，文字随之变软。 */
  maxPixelRatio: number
  /** 画布像素总数上限，`Infinity` 表示不限制。 */
  maxPixels: number
  /** 玻璃体积着色倍率的上限。画布倍率高于它时，玻璃以较低分辨率着色后放大合成。 */
  maxGlassPixelRatio: number
  /** 连续绘制低于约 51 帧时自动降低玻璃着色倍率（最低降到一半），恢复流畅后逐步升回。不改变画布分辨率。 */
  adaptive: boolean
}
