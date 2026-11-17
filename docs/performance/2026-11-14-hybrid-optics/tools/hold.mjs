const [url, runsArg = '1'] = process.argv.slice(2)
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
await send('Page.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR ?? 2), mobile: false })
await send('Page.navigate', { url })
await sleep(5000)
const hold = Number(new URL(url).searchParams.get('hold') ?? 0)
if (!await evaluate(`!!document.querySelector('#stage')`)) { console.error(await evaluate('document.body.innerText.slice(0, 300)')); process.exit(2) }
await evaluate(`document.getElementById('stage-scroll').scrollTo({ top: ${hold}, behavior: 'instant' })`)
await sleep(1500)
if (process.env.OPEN_PANEL) { await evaluate(`document.querySelector('.lg-tuner-launcher').click()`); await sleep(1500) }
const selector = process.env.CLICK
const interval = Number(process.env.CLICK_MS ?? 700)
const out = []
for (let i = 0; i <= Number(runsArg); i++) {
  await evaluate(`document.querySelector('aside button').click()`)
  if (process.env.VIDEO) { await sleep(50); await evaluate(`Promise.all([...document.querySelectorAll('video')].map(video => video.play().then(() => 1).catch(() => 0)))`) }
  if (selector) {
    await evaluate(`(() => { let n = 0; const timer = setInterval(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); if (all.length) all[n++ % all.length].click() }, ${interval}); setTimeout(() => clearInterval(timer), 7900) })()`)
  }
  await sleep(9000)
  const json = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
  if (i === 0) continue
  out.push({ gpuMean: +json.gpu.mean?.toFixed(2), gpuP50: +json.gpu.p50?.toFixed(2), gpuP95: +json.gpu.p95?.toFixed(2), gpuMax: +json.gpu.max?.toFixed(2), draw: +json.draw.mean.toFixed(2), paintMean: +json.paintInterval.mean.toFixed(1), paintP95: +json.paintInterval.p95.toFixed(1), paints: json.draw.count, glassDpr: json.metrics?.glassDpr, optics: json.metrics?.optics, errors: json.errors, bad: json.invalidReasons })
}
console.log(JSON.stringify(out))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
