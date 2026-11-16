import type { GlassRenderMode, LiquidGlassMount } from '../mount'
import type { GlassOptics, StageMetrics, StageResolution } from '../types'
import { supportsSvgBackdropFilter } from '../css/refraction'
import { DEFAULT_STAGE_RESOLUTION } from '../resolution'

/**
 * 调参面板读取和切换渲染方式的接口。
 *
 * 面板在操作之后、展开期间每隔半秒以及调用 `GlassTuner.update()` 时重新读取这些属性，
 * 用 getter 实现即可反映外部的变化。
 */
export interface GlassTunerRenderer {
  /** 当前的渲染方式。 */
  readonly mode: GlassRenderMode
  /** 浏览器是否具备画布渲染所需的全部能力；为 false 时只能使用回退实现。 */
  readonly canvasSupported: boolean
  /** 浏览器能否把 SVG 滤镜用作 `backdrop-filter`；为 false 时回退只有纯 CSS。 */
  readonly svgSupported: boolean
  /** 正在切换渲染方式，期间禁用切换按钮。 */
  readonly switching?: boolean
  /** 最近一次切换失败的原因，没有时为空字符串或省略。 */
  readonly error?: string
  /** 画布渲染的分辨率限制。 */
  readonly resolution: Readonly<StageResolution>
  /** 画布渲染配置的光路计算方式。 */
  readonly optics: GlassOptics
  /** 画布当前的尺寸与实际倍率；回退实现下为 null。 */
  metrics: () => StageMetrics | null
  /**
   * 切换渲染方式。切换需要重新挂载（`dispose()` 后再次 `mountLiquidGlass()`），由调用方实现；
   * 省略时面板只显示当前方式，不能切换。
   */
  setMode?: (mode: GlassRenderMode) => void | Promise<unknown>
  setResolution: (resolution: Partial<StageResolution>) => void
  setOptics: (optics: GlassOptics) => void
}

/** `rendererFromMount()` 的选项。 */
export interface RendererFromMountOptions {
  /** 切换渲染方式，见 `GlassTunerRenderer.setMode`。 */
  setMode?: (mode: GlassRenderMode) => void | Promise<unknown>
}

/**
 * 用 `mountLiquidGlass()` 的返回值实现 `GlassTunerRenderer`：分辨率与光路直接读写画布舞台，
 * 回退实现下修改会被记住，但不起作用。传入函数时每次读取都调用它，挂载被替换后面板自动跟随新的挂载。
 */
export function rendererFromMount(
  mount: LiquidGlassMount | (() => LiquidGlassMount | null),
  options: RendererFromMountOptions = {},
): GlassTunerRenderer {
  const current = typeof mount === 'function'
    ? mount
    : () => mount
  let resolution: StageResolution = {
    ...(current()?.stage?.getResolution() ?? DEFAULT_STAGE_RESOLUTION),
  }
  let optics: GlassOptics = current()?.stage?.getOptics() ?? 'hybrid'
  const svgSupported = supportsSvgBackdropFilter()
  return {
    get mode() {
      return current()?.mode ?? 'css'
    },
    get canvasSupported() {
      return current()?.support.supported ?? false
    },
    svgSupported,
    get resolution() {
      const stage = current()?.stage
      if (stage)
        resolution = stage.getResolution()
      return resolution
    },
    get optics() {
      const stage = current()?.stage
      if (stage)
        optics = stage.getOptics()
      return optics
    },
    metrics: () => current()?.stage?.getMetrics() ?? null,
    setMode: options.setMode,
    setResolution(patch) {
      resolution = {
        ...resolution,
        ...patch,
      }
      current()?.stage?.setResolution(patch)
    },
    setOptics(next) {
      optics = next
      current()?.stage?.setOptics(next)
    },
  }
}
