// 固定条件下截取一组画面，用于渲染器改动前后的逐像素比较。
// 用法: node shots.mjs <站点根地址> <输出目录> [场景名前缀…]
// 站点是 `apps/demo/tests/perf/vite.config.ts` 的构建结果，scroll.html 复制为 index.html。
// 环境变量 QUERY 追加到每个页面的查询参数，例如 `lens=0&backdrop=copy`。
import { mkdir, writeFile } from 'node:fs/promises'

const [base, outDir, ...only] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find(t => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
await mkdir(outDir, { recursive: true })
await send('Page.enable')
await send('Page.bringToFront')

async function open(path, { width = 1563, height = 1013, dpr = 2 } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  const extra = process.env.QUERY
  const url = extra
    ? base + path + (path.includes('?') ? '&' : '?') + extra
    : base + path
  await send('Page.navigate', { url })
  await sleep(4500)
}
async function shot(name) {
  // 等两帧，让最后一次状态变化完成绘制。
  await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`)
  await sleep(900)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${outDir}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.error('saved', name)
}
/** 商店页：暂停视频并定位到第 1 秒，隐藏测量面板，关闭平滑滚动。 */
const prepareStore = `(async () => {
  document.querySelector('aside')?.style.setProperty('display', 'none')
  for (const video of document.querySelectorAll('video')) {
    video.pause()
    await new Promise((resolve) => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 1; setTimeout(resolve, 1500) })
  }
  return !!document.querySelector('#stage')
})()`
const scrollTo = top => `(async () => { const s = document.getElementById('stage-scroll'); s.scrollTo({ top: ${top}, behavior: 'instant' }); return s.scrollTop })()`

const scenarios = {
  async store() {
    await open('/?adaptive=0')
    if (!await evaluate(prepareStore)) throw new Error('画布没有启动')
    for (const top of [0, 300, 600, 900, 1100, 1500, 1900, 2300]) {
      await evaluate(scrollTo(top))
      await sleep(1200)
      await shot(`store-${top}`)
    }
  },
  async tuner() {
    await open('/?adaptive=0')
    await evaluate(prepareStore)
    await evaluate(scrollTo(1100))
    await evaluate(`document.querySelector('.tuner-launcher').click()`)
    await sleep(2500)
    await shot('store-tuner-1100')
  },
  async mobile() {
    await open('/?adaptive=0&maxPixelRatio=3&maxGlassPixelRatio=3', { width: 412, height: 915, dpr: 3 })
    await evaluate(prepareStore)
    for (const top of [0, 700, 1800]) {
      await evaluate(scrollTo(top))
      await sleep(1200)
      await shot(`mobile-${top}`)
    }
  },
  async reduced() {
    // 玻璃以 2 倍着色、画布 3 倍：经过低分辨率离屏目标与分块合成。
    await open('/?adaptive=0&maxPixelRatio=3&maxGlassPixelRatio=2', { width: 412, height: 915, dpr: 3 })
    await evaluate(prepareStore)
    for (const top of [0, 700]) {
      await evaluate(scrollTo(top))
      await sleep(1200)
      await shot(`reduced-${top}`)
    }
  },
  async visual() {
    await open('/tests/visual/liquid-glass.html', { width: 1100, height: 1150, dpr: 2 })
    await shot('visual-default')
    const set = (id, value) => `(() => { const el = document.getElementById('${id}'); if (el.type === 'checkbox') el.checked = ${value}; else el.value = '${value}'; el.dispatchEvent(new Event('input', { bubbles: true })) })()`
    await evaluate(set('gap', -60))
    await sleep(600)
    await shot('visual-overlap')
    await evaluate(set('layer', 1))
    await sleep(600)
    await shot('visual-overlap-layer')
    await evaluate(set('gap', 12))
    await evaluate(set('layer', 0))
    await evaluate(set('blur', 0))
    await evaluate(set('mixed', false))
    await evaluate(set('refraction', 48))
    await evaluate(set('dispersion', 1))
    await sleep(600)
    await shot('visual-clear-thick')
  },
  async content() {
    await open('/tests/visual/glass-content.html', { width: 900, height: 700, dpr: 2 })
    await shot('content-default')
  },
}
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length && !only.some(prefix => name.startsWith(prefix))) continue
  await run()
}
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
