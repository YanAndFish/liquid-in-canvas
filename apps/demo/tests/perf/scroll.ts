import { CanvasStage } from 'liquid-in-canvas/canvas'
import { getStageScroller } from '../../src/shared/scroll'
import { applyGlassQuery, applyStageQuery } from '../query'

interface PassTiming {
  label: string
  target: [number, number]
  ms: number
  begin: number
  end: number
}

interface ObservedStage {
  draw: (event?: Event) => void
  gpu: {
    device: GPUDevice
    timing: {
      enabled: boolean
      onFrame: ((passes: PassTiming[]) => void) | null
    }
    span: {
      ms: number
      samples: number
    }
  } | null
  adaptive: {
    spanBound: boolean
    span: number
    bounded: number
  }
  setResolution: CanvasStage['setResolution']
  setOptics: CanvasStage['setOptics']
  setFieldCache: CanvasStage['setFieldCache']
  getMetrics: CanvasStage['getMetrics']
}

interface PassInfo {
  scene: string
  target: number[] | null
}

const prototype = CanvasStage.prototype as unknown as ObservedStage
const draw = prototype.draw
const query = new URLSearchParams(location.search)
const gpuDiagnostic = query.has('gpu')
const resolutionOverride = {
  ...(query.has('maxPixelRatio')
    ? {
        maxPixelRatio: Number(query.get('maxPixelRatio')),
      }
    : {}),
  ...(query.has('maxGlassPixelRatio')
    ? {
        maxGlassPixelRatio: Number(query.get('maxGlassPixelRatio')),
      }
    : {}),
  ...(query.has('adaptive')
    ? { adaptive: query.get('adaptive') !== '0' }
    : {}),
  ...(query.has('minPixelRatio')
    ? {
        minPixelRatio: Number(query.get('minPixelRatio')),
      }
    : {}),
}
const hold = query.has('hold')
  ? Number(query.get('hold'))
  : null
const configured = new WeakSet<object>()
let readMetrics: (() => ReturnType<CanvasStage['getMetrics']>) | null = null
const errors: string[] = []
let active = false
let measurement = 0
let durations: number[] = []
let paints: number[] = []
let frames: number[] = []
let gpuTimes: number[] = []
let spanSamples: number[] = []
let lastSpanSample = 0
let readAdaptive: (() => ObservedStage['adaptive']) | null = null
let gpuPassSums: number[] = []
let gpuPassTimes: number[][] = []
let gpuPassInfo: PassInfo[][] = []
let positions: number[] = []
let adaptation: [number, number, number, string][] = []
let measurementStart = 0
let lastState = ''
const adaptationLog: [number, number, number, string][] = []
let lastLoggedState = ''

function recordAdaptation(stage: ObservedStage, now: number): void {
  const metrics = stage.getMetrics()
  const state = `${metrics.dpr.toFixed(3)} ${metrics.glassDpr.toFixed(3)} ${metrics.optics}`
  if (state !== lastLoggedState) {
    lastLoggedState = state
    adaptationLog.push([
      Math.round(now),
      +metrics.dpr.toFixed(3),
      +metrics.glassDpr.toFixed(3),
      metrics.optics,
    ])
  }
  if (active && state !== lastState) {
    lastState = state
    adaptation.push([
      Math.round(now - measurementStart),
      +metrics.dpr.toFixed(3),
      +metrics.glassDpr.toFixed(3),
      metrics.optics,
    ])
  }
}
let adapterInfo: Record<string, string | boolean> | null = null

applyGlassQuery(query)

if (query.get('glass') === '0') {
  const strip = (): void => {
    for (const element of document.querySelectorAll('[data-liquid-glass]'))
      element.removeAttribute('data-liquid-glass')
  }
  new MutationObserver(strip).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-liquid-glass'],
  })
}

prototype.draw = function (event) {
  if (!configured.has(this)) {
    configured.add(this)
    if (Object.keys(resolutionOverride).length)
      this.setResolution(resolutionOverride)
    applyStageQuery(this, query)
    readMetrics = this.getMetrics.bind(this)
    if (query.get('spanBound') === '0')
      this.adaptive.spanBound = false
    readAdaptive = () => this.adaptive
  }
  const gpu = this.gpu
  if (!adapterInfo && gpu) {
    const info = gpu.device.adapterInfo
    if (info) {
      adapterInfo = {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: info.isFallbackAdapter,
      }
    }
  }
  if (gpuDiagnostic && gpu && !gpu.timing.onFrame) {
    gpu.timing.enabled = true
    let frameMeasurement = measurement
    gpu.timing.onFrame = (passes) => {
      if (!active || frameMeasurement !== measurement) {
        frameMeasurement = measurement
        return
      }
      gpuTimes.push(Math.max(...passes.map(pass => pass.end)))
      gpuPassSums.push(passes.reduce((sum, pass) => sum + pass.ms, 0))
      gpuPassTimes.push(passes.map(pass => pass.ms))
      gpuPassInfo.push(passes.map(pass => ({
        scene: pass.label,
        target: pass.label === 'canvas'
          ? null
          : pass.target,
      })))
    }
  }
  if (!active) {
    draw.call(this, event)
    recordAdaptation(this, performance.now())
    return
  }
  const start = performance.now()
  draw.call(this, event)
  durations.push(performance.now() - start)
  if (gpu && gpu.span.samples !== lastSpanSample) {
    lastSpanSample = gpu.span.samples
    spanSamples.push(gpu.span.ms)
  }
  paints.push(start)
  recordAdaptation(this, start)
}
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    mean: sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
    max: sorted.at(-1) ?? null,
  }
}

function intervals(values: number[]) {
  return values.slice(1).map((value, index) => value - values[index]!)
}

const panel = document.createElement('aside')
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#111;color:#fff;padding:12px;max-width:490px;font:12px monospace;max-height:38vh;overflow:auto'
const button = document.createElement('button')
button.textContent = '往返滚动 8 秒'
const output = document.createElement('pre')
output.id = 'scroll-result'
panel.append(button, output)
document.body.append(panel)

button.onclick = () => {
  const scroller = getStageScroller()
  if (active || !scroller)
    return
  document.querySelectorAll('video').forEach(video => video.pause())
  scroller.scrollTo({ top: 0, behavior: 'instant' })
  const distance = Math.min(2200, scroller.scrollHeight - scroller.clientHeight)
  durations = []
  paints = []
  frames = []
  gpuTimes = []
  spanSamples = []
  gpuPassSums = []
  gpuPassTimes = []
  gpuPassInfo = []
  measurement++
  positions = []
  adaptation = []
  lastState = ''
  measurementStart = performance.now()
  errors.length = 0
  active = true
  button.disabled = true
  output.textContent = '正在滚动'
  let started: number | undefined
  const frame = (time: number) => {
    started ??= time
    const elapsed = time - started
    if (elapsed >= 8000) {
      active = false
      button.disabled = false
      const invalidReasons = [
        ...errors,
        ...(!document.querySelector('#stage')
          ? ['画布已退出渲染']
          : []),
        ...(durations.length < 30
          ? ['绘制次数不足']
          : []),
        ...(hold === null && Math.max(...positions) < distance * 0.95
          ? ['没有经过规定的滚动范围']
          : []),
      ]
      output.textContent = JSON.stringify({
        comparable: invalidReasons.length === 0,
        invalidReasons,
        gpuDiagnostic,
        adapterInfo,
        elapsed,
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        metrics: readMetrics?.() ?? null,
        adaptation,
        adaptationLog,
        distance,
        hold,
        maxScroll: Math.max(...positions),
        draw: distribution(durations),
        paintInterval: distribution(intervals(paints)),
        animationInterval: distribution(intervals(frames)),
        longAnimationFrames: intervals(frames).filter(value => value > 50).length,
        gpu: distribution(gpuTimes),
        span: {
          ...distribution(spanSamples),
          min: spanSamples.length
            ? Math.min(...spanSamples)
            : null,
          bound: readAdaptive?.().spanBound ?? null,
          window: readAdaptive?.().span ?? null,
          bounded: readAdaptive?.().bounded ?? null,
        },
        gpuPassSum: distribution(gpuPassSums),
        gpuPassTimes,
        gpuPassInfo,
        errors,
      }, null, 2)
      return
    }
    const fraction = elapsed / 8000
    scroller.scrollTo({ top: hold ?? distance * (1 - Math.abs(fraction * 2 - 1)), behavior: 'instant' })
    positions.push(scroller.scrollTop)
    frames.push(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void import('../../src/main')
