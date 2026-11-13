// 用法: DPR=3 [W=.. H=..] node gpu.mjs <url> <runs> [video]
const [url, runsArg = '1', mode = 'scroll'] = process.argv.slice(2)
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
if (process.env.DPR) {
  await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR), mobile: false })
} else await send('Emulation.clearDeviceMetricsOverride')
await send('Page.navigate', { url })
await sleep(5000)
const support = await evaluate(`({ stage: !!document.querySelector('#stage'), viewport: [innerWidth, innerHeight, devicePixelRatio], canvas: [document.querySelector('#stage')?.width, document.querySelector('#stage')?.height] })`)
console.error(JSON.stringify(support))
if (!support.stage) { console.error(await evaluate('document.body.innerText.slice(0, 300)')); process.exit(2) }
if (process.env.OPEN_PANEL) { await evaluate(`document.querySelector('.tuner-launcher').click()`); await sleep(1500) }
const out = []
for (let i = 0; i <= Number(runsArg); i++) {
  await evaluate(`document.querySelector('aside button').click()`)
  if (mode === 'video') { await sleep(50); await evaluate(`document.querySelector('video')?.play().then(()=>1).catch(()=>0)`) }
  await sleep(9000)
  const json = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
  if (i === 0) continue
  const agg = {}; const n = json.gpuPassTimes.length
  for (let f = 0; f < n; f++) json.gpuPassTimes[f].forEach((t, k) => {
    const info = json.gpuPassInfo[f][k]
    const key = !info || !info.target ? 'canvas' : `${info.target[0]}x${info.target[1]}`
    agg[key] = (agg[key] ?? 0) + t / n
  })
  if (process.env.PASSES) { const f = Math.floor(n/2); console.error(JSON.stringify(json.gpuPassTimes[f].map((t,k)=>[(json.gpuPassInfo[f][k]?.target??['canvas']).join('x'), +t.toFixed(2)]))) }
  const groups = { canvas: 0, blur: 0, backdrop: 0 }
  for (const [k, v] of Object.entries(agg)) {
    if (k === 'canvas') groups.canvas += v
    else if (Number(k.split('x')[0]) >= support.viewport[0]) groups.backdrop += v
    else groups.blur += v
  }
  if (process.env.PASSES) console.error(JSON.stringify(Object.fromEntries(Object.entries(agg).map(([k,v])=>[k,+v.toFixed(2)]))))
  out.push({ gpuMean: +json.gpu.mean?.toFixed(2), gpuP50: +json.gpu.p50?.toFixed(2), gpuP95: +json.gpu.p95?.toFixed(2), canvas: +groups.canvas.toFixed(2), blur: +groups.blur.toFixed(2), backdrop: +groups.backdrop.toFixed(2), draw: +json.draw.mean.toFixed(2), paintMean: +json.paintInterval.mean.toFixed(1), paintP95: +json.paintInterval.p95.toFixed(1), paints: json.draw.count, errors: json.errors, bad: json.invalidReasons })
}
console.log(JSON.stringify(out))
ws.close()
