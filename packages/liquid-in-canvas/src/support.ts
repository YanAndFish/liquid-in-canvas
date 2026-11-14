/// <reference path="./html-in-canvas.d.ts" />
import type { StageCapability, StageSupport, StageSupportReport } from './types'

interface ElementUploadQueue {
  drawElementImageToTexture?: unknown
}

interface StageSupportScope {
  createProbe?: () => HTMLCanvasElement
  userAgent?: string
  webgpu?: boolean
  gpuQueue?: ElementUploadQueue | null
}

interface GPUQueueConstructor {
  prototype: ElementUploadQueue
}

function currentUserAgent(): string {
  return typeof navigator === 'undefined'
    ? ''
    : navigator.userAgent
}

function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

function defaultGpuQueue(): ElementUploadQueue | null {
  const constructor = (globalThis as { GPUQueue?: GPUQueueConstructor }).GPUQueue
  return constructor?.prototype ?? null
}

function labelBrowser(userAgent: string): string {
  const electron = userAgent.match(/Electron\/(\d+)/)
  const chromium = userAgent.match(/Chrome\/(\d+)/)
  if (electron) {
    return chromium
      ? `Electron ${electron[1]} · Chromium ${chromium[1]}`
      : `Electron ${electron[1]}`
  }
  if (chromium)
    return `Chrome ${chromium[1]}`

  const firefox = userAgent.match(/Firefox\/(\d+)/)
  if (firefox)
    return `Firefox ${firefox[1]}`

  const safari = userAgent.match(/Version\/(\d+)/)
  if (safari && userAgent.includes('Safari'))
    return `Safari ${safari[1]}`

  return 'Unknown browser'
}

function probeHtmlInCanvas(probe: HTMLCanvasElement): boolean {
  return probe.content === 'drawable'
    && typeof probe.requestPaint === 'function'
    && typeof probe.updateElementGeometry === 'function'
}

function createProbe(): HTMLCanvasElement {
  const probe = document.createElement('canvas')
  probe.setAttribute('content', 'drawable')
  return probe
}

export function detectStageSupport(scope: StageSupportScope = {}): StageSupport {
  const probe = scope.createProbe?.() ?? createProbe()
  const gpuQueue = scope.gpuQueue === undefined
    ? defaultGpuQueue()
    : scope.gpuQueue
  const report: StageSupportReport = {
    htmlInCanvas: probeHtmlInCanvas(probe),
    webgpu: scope.webgpu ?? hasWebGPU(),
    drawElementImageToTexture: typeof gpuQueue?.drawElementImageToTexture === 'function',
    browser: labelBrowser(scope.userAgent ?? currentUserAgent()),
  }

  const missing: StageCapability[] = []
  if (!report.htmlInCanvas)
    missing.push('html-in-canvas')
  if (!report.webgpu)
    missing.push('webgpu')
  if (!report.drawElementImageToTexture)
    missing.push('draw-element-image-to-texture')

  if (missing.length === 0)
    return { supported: true, report, missing: [] }

  return { supported: false, report, missing }
}

export type { StageSupportScope }
