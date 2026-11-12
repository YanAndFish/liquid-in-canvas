import type { WebGPURenderer } from 'three/webgpu'
import { CanvasStage } from '../../src/stage/CanvasStage'
import { getStageScroller } from '../../src/stage/contract'

/** 供独立测试入口观察的绘制方法与 GPU 渲染器。 */
interface ObservedStage {
  /** 上传页面并提交这一帧的绘制命令。 */
  draw: (event?: Event) => void
  /** 初始化后的渲染器，尚未初始化时为 null。 */
  renderer: WebGPURenderer | null
}

/** Three.js GPU 查询完成后提供的逐遍绘制记录。 */
interface TimestampBackend {
  /** 按渲染或计算分类的查询池。 */
  timestampQueryPool: {
    /** 尚未创建查询池时为 undefined。 */
    render?: {
      /** 键包含绘制上下文和帧号，值为毫秒。 */
      timestamps: Map<string, number>
    }
  }
}

/** 将 GPU 时间对应到实际绘制场景和目标尺寸。 */
interface PassInfo {
  /** 场景或全屏网格的类型。 */
  scene: string
  /** 场景的直接子节点数量。 */
  children: number
  /** 离屏目标尺寸；null 表示输出到画布。 */
  target: number[] | null
}

const prototype = CanvasStage.prototype as unknown as ObservedStage
const draw = prototype.draw
const gpuDiagnostic = new URLSearchParams(location.search).has('gpu')
const errors: string[] = []
let active = false
let resolving = false
let measurement = 0
let durations: number[] = []
let paints: number[] = []
let frames: number[] = []
let gpuTimes: number[] = []
let gpuPassTimes: number[][] = []
let gpuPassInfo: (PassInfo | undefined)[][] = []
let positions: number[] = []
const observedRenderers = new WeakSet<WebGPURenderer>()
const passInfo = new Map<string, PassInfo>()
let adapterInfo: Record<string, string | boolean> | null = null

prototype.draw = function (event) {
  const renderer = this.renderer
  const backend = renderer?.backend
  const timestamps = !!renderer?.hasFeature('timestamp-query')
  if (!adapterInfo && backend && 'device' in backend && backend.device) {
    const info = (backend.device as GPUDevice).adapterInfo
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
  if (gpuDiagnostic && renderer && !observedRenderers.has(renderer)) {
    observedRenderers.add(renderer)
    const inspector = renderer.inspector
    const beginRender = inspector.beginRender.bind(inspector)
    inspector.beginRender = (uid, scene, camera, target) => {
      if (active) {
        passInfo.set(uid, {
          scene: scene.type,
          children: scene.children.length,
          target: target
            ? [target.width, target.height]
            : null,
        })
      }
      beginRender(uid, scene, camera, target)
    }
  }
  if (gpuDiagnostic && backend && 'trackTimestamp' in backend)
    backend.trackTimestamp = timestamps
  if (!active) {
    draw.call(this, event)
    return
  }
  const start = performance.now()
  draw.call(this, event)
  durations.push(performance.now() - start)
  paints.push(start)
  if (gpuDiagnostic && renderer && timestamps && !resolving) {
    resolving = true
    const currentMeasurement = measurement
    void renderer.resolveTimestampsAsync().then((duration) => {
      if (active && currentMeasurement === measurement && duration !== undefined) {
        gpuTimes.push(duration)
        const pool = (renderer.backend as unknown as TimestampBackend).timestampQueryPool.render
        const passes = [
          ...pool?.timestamps ?? [],
        ]
        const frame = passes.at(-1)?.[0].split(':f').at(-1)
        const framePasses = passes.filter(([key]) => key.endsWith(`:f${frame}`))
        gpuPassTimes.push(framePasses.map(([, value]) => value))
        gpuPassInfo.push(framePasses.map(([key]) => passInfo.get(key)))
      }
    }).finally(() => { resolving = false })
  }
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

/** 暂停视频，在相同八秒路径中向下滚动 2200 像素，再回到顶部。 */
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
  gpuPassTimes = []
  gpuPassInfo = []
  passInfo.clear()
  measurement++
  positions = []
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
        ...(Math.max(...positions) < distance * 0.95
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
        distance,
        maxScroll: Math.max(...positions),
        draw: distribution(durations),
        paintInterval: distribution(intervals(paints)),
        animationInterval: distribution(intervals(frames)),
        longAnimationFrames: intervals(frames).filter(value => value > 50).length,
        gpu: distribution(gpuTimes),
        gpuPassTimes,
        gpuPassInfo,
        errors,
      }, null, 2)
      return
    }
    const fraction = elapsed / 8000
    scroller.scrollTo({ top: distance * (1 - Math.abs(fraction * 2 - 1)), behavior: 'instant' })
    positions.push(scroller.scrollTop)
    frames.push(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void import('../../src/main')
