import { CanvasStage } from 'liquid-in-canvas/canvas'
import { getStageScroller } from '../../src/shared/scroll'
import { applyGlassQuery, applyStageQuery } from '../query'

/** 一遍绘制的 GPU 时间，由舞台的计时器读回。 */
interface PassTiming {
  /** 这一遍的用途：`backdrop`、`blur`、`band` 或 `canvas`。 */
  label: string
  /** 绘制目标的像素尺寸。 */
  target: [number, number]
  /** 从开始到结束的时间，毫秒。 */
  ms: number
  /** 开始与结束相对本帧第一遍开始的时间，毫秒。 */
  begin: number
  end: number
}

/** 供独立测试入口观察的绘制方法与 GPU 上下文。 */
interface ObservedStage {
  /** 上传页面并提交这一帧的绘制命令。 */
  draw: (event?: Event) => void
  /** 初始化后的 GPU 上下文，尚未初始化时为 null。 */
  gpu: {
    device: GPUDevice
    timing: {
      enabled: boolean
      onFrame: ((passes: PassTiming[]) => void) | null
    }
  } | null
  /** 修改分辨率限制。 */
  setResolution: CanvasStage['setResolution']
  /** 切换光路计算方式。 */
  setOptics: CanvasStage['setOptics']
  /** 打开或关闭混合光路的折射场缓存。 */
  setFieldCache: CanvasStage['setFieldCache']
  /** 打开或关闭快照复用。 */
  setSnapshotReuse: CanvasStage['setSnapshotReuse']
  /** 当前画布尺寸、倍率与实际使用的光路。 */
  getMetrics: CanvasStage['getMetrics']
}

/** 将 GPU 时间对应到绘制目标。 */
interface PassInfo {
  /** 这一遍的用途。 */
  scene: string
  /** 离屏目标尺寸；null 表示输出到画布。 */
  target: number[] | null
}

const prototype = CanvasStage.prototype as unknown as ObservedStage
const draw = prototype.draw
const query = new URLSearchParams(location.search)
const gpuDiagnostic = query.has('gpu')
/** `?maxPixelRatio=3&maxGlassPixelRatio=1&adaptive=0` 用于在固定倍率下对比，缺省使用库的默认限制。 */
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
/** `?hold=600` 在八秒里停在给定的滚动位置，用于测量某个画面持续重绘时的开销（需要视频或动画保持重绘）。 */
const hold = query.has('hold')
  ? Number(query.get('hold'))
  : null
/**
 * `?press=400` 在测量期间停在当前滚动位置，每 400 ms 交替按下、松开视口里的第一块玻璃
 * （合成的指针事件，不触发 `:active` 样式），只有玻璃的按压弹簧在动，页面本身不变。
 * 与 `?reuse=1` 对照，测量快照复用能省下多少。
 */
const pressPeriod = query.has('press')
  ? Number(query.get('press')) || 400
  : null
const configured = new WeakSet<object>()
/** 读取舞台的实际倍率与光路（自适应降级后的结果），测量结束时调用。 */
let readMetrics: (() => ReturnType<CanvasStage['getMetrics']>) | null = null
const errors: string[] = []
let active = false
let measurement = 0
/** 测量期间整页快照（源元素是舞台根元素）与其他元素的上传次数。 */
let rootUploads = 0
let otherUploads = 0
const uploadElement = GPUQueue.prototype.drawElementImageToTexture
GPUQueue.prototype.drawElementImageToTexture = function (source, destination) {
  if (active) {
    if (source.source.parentElement?.id === 'stage')
      rootUploads++
    else
      otherUploads++
  }
  uploadElement.call(this, source, destination)
}
let durations: number[] = []
let paints: number[] = []
let frames: number[] = []
let gpuTimes: number[] = []
let gpuPassSums: number[] = []
let gpuPassTimes: number[][] = []
let gpuPassInfo: PassInfo[][] = []
let positions: number[] = []
/** 自适应降级的变化记录：`[距测量开始的毫秒数, 画布倍率, 玻璃着色倍率, 光路]`，第一项是测量开始时的状态。 */
let adaptation: [number, number, number, string][] = []
let measurementStart = 0
let lastState = ''
/** 自页面加载起的全部变化：`[距页面加载的毫秒数, 画布倍率, 玻璃着色倍率, 光路]`，不随测量重置。 */
const adaptationLog: [number, number, number, string][] = []
let lastLoggedState = ''

/** 记录舞台当前的实际倍率与光路，有变化时追加到两份记录里。 */
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

// `?glass=0` 去掉页面上所有玻璃声明，只测量整页快照与页面绘制的开销。
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
      // 同一命令缓冲里的遍相互重叠，整帧时间取第一遍开始到最后一遍结束；逐遍相加会重复计算等待。
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
  paints.push(start)
  recordAdaptation(this, start)
}
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

/** 汇总毫秒数据，空数组只报告零个样本。 */
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

/** 返回相邻时间点的间隔。 */
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

/** 视口里第一块完整可见的玻璃，按压测量的目标。 */
function pressTarget(): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-liquid-glass]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth)
      return element
  }
  return null
}

/** 暂停视频，在相同八秒路径中向下滚动 2200 像素，再回到顶部；带 `?hold` 时停在给定位置。 */
button.onclick = () => {
  const scroller = getStageScroller()
  if (active || !scroller)
    return
  document.querySelectorAll('video').forEach(video => video.pause())
  scroller.scrollTo({ top: 0, behavior: 'instant' })
  const distance = Math.min(2200, scroller.scrollHeight - scroller.clientHeight)
  durations = []
  rootUploads = 0
  otherUploads = 0
  paints = []
  frames = []
  gpuTimes = []
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
  let pressed = false
  if (pressPeriod !== null)
    scroller.scrollTo({ top: hold ?? 0, behavior: 'instant' })
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
        ...(hold === null && pressPeriod === null && Math.max(...positions) < distance * 0.95
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
        pressPeriod,
        uploads: { root: rootUploads, other: otherUploads },
        draw: distribution(durations),
        paintInterval: distribution(intervals(paints)),
        animationInterval: distribution(intervals(frames)),
        longAnimationFrames: intervals(frames).filter(value => value > 50).length,
        gpu: distribution(gpuTimes),
        gpuPassSum: distribution(gpuPassSums),
        gpuPassTimes,
        gpuPassInfo,
        errors,
      }, null, 2)
      return
    }
    const fraction = elapsed / 8000
    if (pressPeriod !== null) {
      const down = Math.floor(elapsed / pressPeriod) % 2 === 0
      if (down !== pressed) {
        pressed = down
        if (down)
          pressTarget()?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        else
          window.dispatchEvent(new PointerEvent('pointerup'))
      }
    }
    else {
      scroller.scrollTo({ top: hold ?? distance * (1 - Math.abs(fraction * 2 - 1)), behavior: 'instant' })
    }
    positions.push(scroller.scrollTop)
    frames.push(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void import('../../src/main')
