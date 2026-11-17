const [url] = process.argv.slice(2)
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
await send('Emulation.setDeviceMetricsOverride', { width: 1563, height: 1013, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(5000)
const hold = Number(new URL(url).searchParams.get('hold') ?? 0)
await evaluate(`document.getElementById('stage-scroll').scrollTo({ top: ${hold}, behavior: 'instant' })`)
await sleep(1500)
const selector = process.env.CLICK ?? '.lg-tuner-launcher'
const interval = Number(process.env.CLICK_MS ?? 900)
await evaluate(`document.querySelector('aside button').click()`)
if (process.env.VIDEO) { await sleep(50); await evaluate(`Promise.all([...document.querySelectorAll('video')].map(video => video.play().then(() => 1).catch(() => 0)))`) }
await evaluate(`(() => { let n = 0; const timer = setInterval(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); if (all.length) all[n++ % all.length].click() }, ${interval}); setTimeout(() => clearInterval(timer), 7900) })()`)
await sleep(9000)
const json = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
const frames = json.gpuPassInfo.map((passes, f) => ({
  total: Math.max(...json.gpuPassTimes[f]) && null,
  field: passes.reduce((sum, pass, k) => pass.scene === 'field' ? sum + json.gpuPassTimes[f][k] : sum, 0),
  baked: passes.some(pass => pass.scene === 'field'),
  target: passes.find(pass => pass.scene === 'field')?.target ?? null,
}))
const sums = json.gpuPassTimes.map(times => times.reduce((a, b) => a + b, 0))
const baked = frames.map((frame, f) => ({ ...frame, sum: sums[f] })).filter(frame => frame.baked)
const others = sums.filter((_, f) => !frames[f].baked)
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
console.log(JSON.stringify({
  frames: frames.length,
  bakes: baked.length,
  fieldPassMs: baked.map(frame => +frame.field.toFixed(2)),
  fieldTargets: baked.map(frame => frame.target),
  bakeFramePassSum: baked.map(frame => +frame.sum.toFixed(2)),
  otherFramePassSumMean: +(mean(others) ?? 0).toFixed(2),
  gpu: json.gpu,
}))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
