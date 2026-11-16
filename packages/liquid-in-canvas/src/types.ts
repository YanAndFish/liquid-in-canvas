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
 * - `profile`：按到轮廓的距离查预先沿截面追踪的光路，每个像素的开销固定、远低于逐步求交；
 *   单块玻璃上与 `raymarch` 一致，融合连接处与小圆角拐角是近似。
 * - `raymarch`：在三维距离场里逐步求交，融合连接处与拐角都按三维实体折射，开销约为前者的三倍。
 * - `hybrid`（缺省）：逐像素混合。只有一块玻璃的组按 `profile` 查表；融合的组与被 `data-glass-clip` 切开的玻璃里，
 *   离其余成员和裁剪边足够远的像素查表，连接处与裁剪边附近求交，静止的画面在这些地方与 `raymarch` 一致。
 *   缺省缓存求交结果（`fieldCache`）：几何静止后求交一次，运动中这一组查表。
 */
export type GlassOptics = 'raymarch' | 'profile' | 'hybrid'

export interface StageMetrics {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  /** 画布的实际渲染倍率，也是页面文字的倍率；受静态上限限制或被自适应降级降低后会低于 `devicePixelRatio`。 */
  dpr: number
  /** 两个静态上限给出的画布倍率。`dpr` 低于它说明自适应降级降低了画布倍率。 */
  targetDpr: number
  /** 玻璃体积的实际着色倍率，不高于 `dpr`。 */
  glassDpr: number
  /** 实际使用的光路。配置为 `hybrid` 或 `raymarch` 时，自适应降级的第一级会临时改用 `profile`。 */
  optics: GlassOptics
}

/**
 * 渲染分辨率的限制。
 *
 * 画布分辨率决定整页文字的清晰度，由 `maxPixelRatio` 与 `maxPixels` 这两个静态上限决定；
 * 自适应降级缺省不改变它；`minPixelRatio` 显式放低之后，才会在其余手段无效或用尽时降低。
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
   * 之后逐级降低玻璃着色倍率（最低降到一半）；设置了 `minPixelRatio` 时最后逐级降低画布倍率。
   * 每降一级都会检验：绘制间隔没有明显缩短就撤回这一级，并在一段时间内跳过这种手段。
   */
  adaptive: boolean
  /**
   * 自适应降级可以把画布倍率降到的下限，缺省 `Infinity`：不降低画布倍率，文字不会因此变软。
   * 设为较小的值（例如 1）表示允许用变软的文字换帧率，实际下限不低于 1 与 `devicePixelRatio` 中的较小值。
   * 只在 `adaptive` 开启时起作用，不影响两个静态上限的结果。
   */
  minPixelRatio: number
}
