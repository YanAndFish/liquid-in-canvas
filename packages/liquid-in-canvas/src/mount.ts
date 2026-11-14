import type { CanvasStage, CanvasStageOptions } from './CanvasStage'
import type { GlassTheme } from './liquid-glass/defaults'
import type { StageFault, StageSupport } from './types'
import { CssGlassStage } from './css/CssGlassStage'
import { detectStageSupport } from './support'

/**
 * 实际使用的渲染方式，效果从完整到简化：
 *
 * - `canvas`：HTML-in-Canvas + WebGPU，完整效果。
 * - `svg`：`backdrop-filter` 加 SVG 位移滤镜，有边缘折射与色散，需要 Chromium 内核。
 * - `css`：只用 `backdrop-filter`，模糊、染色、阴影与轮廓高光。
 */
export type GlassRenderMode = 'canvas' | 'svg' | 'css'

export interface MountLiquidGlassOptions extends Pick<CanvasStageOptions, 'resolution' | 'theme' | 'optics'> {
  /** 页面根元素。画布模式下挂载后成为画布的子元素，仍然可以交互。 */
  root: HTMLElement
  /**
   * 渲染方式，缺省为 `auto`：按 `canvas` → `svg` → `css` 的顺序使用浏览器支持的第一种；
   * 画布初始化失败或运行中出错时也会改用回退实现。
   * 指定 `canvas` 时不做回退，不支持或初始化失败会抛出错误。
   * 指定 `svg` 而浏览器不支持时使用 `css`，以返回值的 `mode` 为准。
   */
  mode?: 'auto' | GlassRenderMode
  /** 画布的 class，用来设置尺寸，例如铺满视口。 */
  canvasClass?: string
  /** 画布的 id。 */
  canvasId?: string
  /** 根元素已经就位、尚未开始绘制时调用，适合在这里挂载框架应用。 */
  beforeStart?: (root: HTMLElement, mode: GlassRenderMode) => void
  /**
   * 画布不可用或出错时调用。`auto` 模式下此时已经切换到回退实现，`kind` 说明原因；
   * `canvas` 模式下只会收到 `runtime`，舞台已停止绘制，由调用方决定后续处理。
   */
  onFault?: (fault: StageFault) => void
}

export interface LiquidGlassMount {
  /** 当前实际使用的渲染方式。`auto` 模式下画布运行中出错后会变为 `svg` 或 `css`。 */
  readonly mode: GlassRenderMode
  /** 画布模式下的舞台，可用于调整分辨率；回退实现下为 null。 */
  readonly stage: CanvasStage | null
  readonly canvas: HTMLCanvasElement | null
  /** 挂载时的能力检测结果。 */
  readonly support: StageSupport
  /** 固定玻璃主题，传入 null 恢复跟随页面。 */
  setTheme: (theme: GlassTheme | null) => void
  /** 停止渲染并把页面恢复到挂载前的状态。 */
  dispose: () => void
}

/** 指定 `mode: 'canvas'` 而浏览器缺少所需能力时由 `mountLiquidGlass()` 抛出。 */
export class StageUnsupportedError extends Error {
  readonly support: StageSupport

  constructor(support: StageSupport) {
    super(`Liquid glass canvas stage is not supported: missing ${support.missing.join(', ')}`)
    this.name = 'StageUnsupportedError'
    this.support = support
  }
}

interface CanvasBackend {
  stage: CanvasStage
  canvas: HTMLCanvasElement
}

/**
 * 一步完成挂载：检测能力，选择渲染方式并开始绘制。
 *
 * 画布模式下创建画布并插入到根元素原来的位置，根元素移入画布，画布尺寸由调用方的样式决定。
 * 回退实现不改变页面结构，只给 `[data-liquid-glass]` 元素加上样式。
 */
export async function mountLiquidGlass(options: MountLiquidGlassOptions): Promise<LiquidGlassMount> {
  const { root, canvasClass, canvasId, beforeStart, onFault, resolution, optics } = options
  const requested = options.mode ?? 'auto'
  const support = detectStageSupport()
  let theme = options.theme ?? null
  let canvasBackend: CanvasBackend | null = null
  let cssBackend: CssGlassStage | null = null
  let disposed = false

  function releaseCanvas(): void {
    const backend = canvasBackend
    if (!backend)
      return
    canvasBackend = null
    backend.stage.dispose()
    if (root.parentElement === backend.canvas)
      backend.canvas.before(root)
    root.removeAttribute('drawable')
    backend.canvas.remove()
  }

  /** 启动回退实现并返回它实际的方式。指定 `css` 时不使用折射滤镜。 */
  function createFallback(): CssGlassStage {
    cssBackend = new CssGlassStage({
      root,
      theme: theme ?? undefined,
      refraction: requested !== 'css',
    })
    return cssBackend
  }

  function fallbackMode(backend: CssGlassStage): GlassRenderMode {
    return backend.refraction
      ? 'svg'
      : 'css'
  }

  function startFallback(): void {
    const backend = createFallback()
    beforeStart?.(root, fallbackMode(backend))
    backend.start()
  }

  function handleRuntimeFault(cause: unknown): void {
    const fault: StageFault = { kind: 'runtime', support, cause }
    if (requested !== 'auto') {
      onFault?.(fault)
      return
    }
    // 错误在绘制回调中抛出，等当前帧结束后再拆除画布。
    queueMicrotask(() => {
      if (disposed || !canvasBackend)
        return
      releaseCanvas()
      // 页面已经挂载过，这里不再调用 beforeStart。
      createFallback().start()
      onFault?.(fault)
    })
  }

  async function startCanvas(): Promise<void> {
    // 画布渲染器在这里才加载，用不到画布的浏览器不会下载它。
    const { CanvasStage } = await import('./CanvasStage')
    const canvas = document.createElement('canvas')
    if (canvasId)
      canvas.id = canvasId
    if (canvasClass)
      canvas.className = canvasClass
    canvas.setAttribute('content', 'drawable')
    root.before(canvas)
    const stage = new CanvasStage({
      canvas,
      resolution,
      optics,
      theme: theme ?? undefined,
      onFault: handleRuntimeFault,
    })
    canvasBackend = { stage, canvas }
    try {
      await stage.init()
      canvas.appendChild(root)
      beforeStart?.(root, 'canvas')
      stage.start(root)
    }
    catch (cause) {
      releaseCanvas()
      throw cause
    }
  }

  if (requested === 'canvas' && !support.supported)
    throw new StageUnsupportedError(support)

  if ((requested === 'auto' || requested === 'canvas') && support.supported) {
    try {
      await startCanvas()
    }
    catch (cause) {
      if (requested === 'canvas')
        throw cause
      startFallback()
      onFault?.({ kind: 'init', support, cause })
    }
  }
  else {
    startFallback()
    if (requested === 'auto')
      onFault?.({ kind: 'unsupported', support })
  }

  return {
    get mode() {
      if (canvasBackend)
        return 'canvas'
      return cssBackend
        ? fallbackMode(cssBackend)
        : 'css'
    },
    get stage() {
      return canvasBackend?.stage ?? null
    },
    get canvas() {
      return canvasBackend?.canvas ?? null
    },
    support,
    setTheme(next) {
      theme = next
      canvasBackend?.stage.setTheme(next)
      cssBackend?.setTheme(next)
    },
    dispose() {
      if (disposed)
        return
      disposed = true
      releaseCanvas()
      cssBackend?.dispose()
      cssBackend = null
    },
  }
}
