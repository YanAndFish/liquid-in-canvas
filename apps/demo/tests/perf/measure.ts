import { CanvasStage } from 'liquid-in-canvas/canvas'
import { createHtmlPaintOrderComparator } from '../../../../packages/liquid-in-canvas/src/liquid-glass/content-order'

/** 生产构建测量入口，只在这个独立测试页面中记录每次绘制的 CPU 耗时。 */
interface MeasuredStage {
  /** 上传 HTML、同步玻璃并提交 GPU 绘制命令。 */
  draw: (event?: Event) => void
}

const prototype = CanvasStage.prototype as unknown as MeasuredStage
const draw = prototype.draw
const errors: string[] = []
let active = false
let durations: number[] = []
let paints: number[] = []
let frames: number[] = []

prototype.draw = function (event) {
  if (!active) {
    draw.call(this, event)
    return
  }
  const start = performance.now()
  draw.call(this, event)
  durations.push(performance.now() - start)
  paints.push(start)
}
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))

/** 返回持续时间的分布，单位为毫秒。 */
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  }
}

/** 把相邻时间点转换为间隔。 */
function intervals(values: number[]) {
  return values.slice(1).map((value, index) => value - values[index]!)
}

const panel = document.createElement('aside')
panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#111;color:#fff;padding:12px;max-width:520px;font:12px monospace;max-height:50vh;overflow:auto'
const startButton = document.createElement('button')
startButton.textContent = '记录 8 秒'
const output = document.createElement('pre')
output.id = 'perf-result'
const sortButton = document.createElement('button')
sortButton.textContent = '测量内容排序'
sortButton.style.marginLeft = '16px'
panel.append(startButton, sortButton, output)
document.body.append(panel)

/** 记录真实页面绘制和浏览器动画帧。此结果不包含 GPU 执行完成时间。 */
startButton.onclick = () => {
  if (active)
    return
  durations = []
  paints = []
  frames = []
  errors.length = 0
  output.textContent = '正在记录'
  startButton.disabled = true
  const started = performance.now()
  const video = document.querySelector('video')
  const videoStart = video?.currentTime ?? 0
  active = true
  const frame = (time: number) => {
    if (active) {
      frames.push(time)
      requestAnimationFrame(frame)
    }
  }
  requestAnimationFrame(frame)
  setTimeout(() => {
    active = false
    startButton.disabled = false
    const invalidReasons = [
      ...errors,
      ...(!document.querySelector('#stage')
        ? ['画布已退出渲染']
        : []),
      ...(durations.length < 30
        ? ['绘制次数少于 30，不能用于动态场景对比']
        : []),
      ...(!video || video.paused
        ? ['背景视频未播放']
        : []),
      ...(video?.currentTime === videoStart
        ? ['视频时间没有推进']
        : []),
    ]
    output.textContent = JSON.stringify({
      comparable: invalidReasons.length === 0,
      invalidReasons,
      elapsed: performance.now() - started,
      viewport: [innerWidth, innerHeight, devicePixelRatio],
      draw: distribution(durations),
      paintInterval: distribution(intervals(paints)),
      animationInterval: distribution(intervals(frames)),
      longAnimationFrames: intervals(frames).filter(value => value > 50).length,
      errors,
      stagePresent: !!document.querySelector('#stage'),
      videoPlaying: !!video && !video.paused,
      videoTime: [videoStart, video?.currentTime],
    }, null, 2)
  }, 8000)
}

/** 使用页面当前可见的玻璃测量排序，同时输出顺序和样式读取次数。 */
sortButton.onclick = () => {
  if (active)
    return
  const elements = [
    ...document.querySelectorAll<HTMLElement>('[data-liquid-glass]'),
  ].filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.left < innerWidth && rect.right > 0
      && rect.top < innerHeight && rect.bottom > 0 && !element.parentElement?.closest('[data-liquid-glass]')
  })
  const sort = () => [...elements].sort(createHtmlPaintOrderComparator())
  for (let index = 0; index < 100; index++)
    sort()
  const readStyle = window.getComputedStyle
  let reads = 0
  let order: HTMLElement[]
  try {
    window.getComputedStyle = (...args) => {
      reads++
      return readStyle.apply(window, args)
    }
    order = sort()
  }
  finally {
    window.getComputedStyle = readStyle
  }
  const expected = order.map(element => elements.indexOf(element)).join(',')
  let mismatches = 0
  const started = performance.now()
  for (let index = 0; index < 1000; index++) {
    const result = sort().map(element => elements.indexOf(element)).join(',')
    if (result !== expected)
      mismatches++
  }
  const elapsed = performance.now() - started
  output.textContent = JSON.stringify({
    kind: 'content-sort',
    iterations: 1000,
    elements: elements.length,
    styleReads: reads,
    order: expected,
    elapsed,
    mean: elapsed / 1000,
    mismatches,
    comparable: elements.length > 1 && mismatches === 0 && errors.length === 0,
    errors: [...errors],
  }, null, 2)
}

void import('../../src/main')
