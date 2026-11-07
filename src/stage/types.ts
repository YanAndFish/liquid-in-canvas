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
  dpr: number
}
