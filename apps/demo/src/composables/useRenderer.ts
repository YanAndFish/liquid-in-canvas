import type { GlassOptics, GlassRenderMode, StageMetrics, StageResolution } from 'liquid-in-canvas'
import type { InjectionKey, Ref } from 'vue'
import { inject } from 'vue'

export interface RendererController {
  mode: Readonly<Ref<GlassRenderMode>>
  canvasSupported: boolean
  svgSupported: boolean
  switching: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  resolution: Readonly<Ref<StageResolution>>
  optics: Readonly<Ref<GlassOptics>>
  metrics: () => StageMetrics | null
  setMode: (mode: GlassRenderMode) => Promise<void>
  setResolution: (resolution: Partial<StageResolution>) => void
  setOptics: (optics: GlassOptics) => void
}

export const RENDERER_KEY: InjectionKey<RendererController> = Symbol('renderer')

export function useRenderer(): RendererController | null {
  return inject(RENDERER_KEY, null)
}
