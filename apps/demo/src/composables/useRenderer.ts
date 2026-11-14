import type { GlassOptics, GlassRenderMode, StageMetrics, StageResolution } from 'liquid-in-canvas'
import type { InjectionKey, Ref } from 'vue'
import { inject } from 'vue'

/** 调参面板与启动代码之间的接口：查询并切换液态玻璃的渲染方式。 */
export interface RendererController {
  /** 当前的渲染方式。 */
  mode: Readonly<Ref<GlassRenderMode>>
  /** 浏览器是否具备画布渲染所需的全部能力；为 false 时只能使用回退实现。 */
  canvasSupported: boolean
  /** 浏览器能否把 SVG 滤镜用作 `backdrop-filter`；为 false 时回退只有纯 CSS。 */
  svgSupported: boolean
  /** 正在切换渲染方式。 */
  switching: Readonly<Ref<boolean>>
  /** 最近一次切换失败的原因，成功后清空。 */
  error: Readonly<Ref<string>>
  /** 画布渲染的分辨率限制。 */
  resolution: Readonly<Ref<StageResolution>>
  /** 画布渲染的光路计算方式。 */
  optics: Readonly<Ref<GlassOptics>>
  /** 画布当前的尺寸与实际倍率；回退实现下为 null。 */
  metrics: () => StageMetrics | null
  setMode: (mode: GlassRenderMode) => Promise<void>
  setResolution: (resolution: Partial<StageResolution>) => void
  setOptics: (optics: GlassOptics) => void
}

export const RENDERER_KEY: InjectionKey<RendererController> = Symbol('renderer')

/** 取得渲染控制器；组件单独挂载（例如测试）时为 null。 */
export function useRenderer(): RendererController | null {
  return inject(RENDERER_KEY, null)
}
