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

/**
 * 画布渲染的光路计算方式。
 *
 * - `profile`（缺省）：按到轮廓的距离查预先沿截面追踪的光路，每个像素的开销固定、远低于逐步求交；
 *   单块玻璃上与 `raymarch` 一致，融合连接处与小圆角拐角是近似。
 * - `raymarch`：在三维距离场里逐步求交，融合连接处与拐角都按三维实体折射，开销约为前者的三倍。
 * - `hybrid`：逐像素混合。只有一块玻璃的组按 `profile` 查表；融合的组与被 `data-glass-clip` 切开的玻璃里，
 *   离其余成员和裁剪边足够远的像素查表，连接处与裁剪边附近求交，静止的画面在这些地方与 `raymarch` 一致。
 *   缺省缓存求交结果（`fieldCache`）：几何静止后求交一次，运动中这一组查表。
 */
export type GlassOptics = 'raymarch' | 'profile' | 'hybrid'

export interface StageMetrics {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  /** 画布的实际渲染倍率，也是页面文字的倍率；可能低于 `devicePixelRatio`。 */
  dpr: number
  /** 玻璃体积的实际着色倍率，不高于 `dpr`。 */
  glassDpr: number
  /** 实际使用的光路。配置为 `hybrid` 或 `raymarch` 时，自适应降级的第一级会临时改用 `profile`。 */
  optics: GlassOptics
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
  /**
   * 连续绘制低于约 51 帧时自动降级，恢复流畅后逐步升回。光路不是 `profile` 时先改用 `profile`（只影响融合连接处与裁剪边），
   * 之后逐级降低玻璃着色倍率（最低降到一半）。不改变画布分辨率。
   */
  adaptive: boolean
}
