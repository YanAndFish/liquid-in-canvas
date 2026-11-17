const [url, runsArg = '4'] = process.argv.slice(2)
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
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id
  pending.set(n, resolve)
  ws.send(JSON.stringify({ id: n, method, params }))
})
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
await send('Page.enable')
await send('Page.bringToFront')
if (process.env.DPR) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.W ?? 1563),
    height: Number(process.env.H ?? 1013),
    deviceScaleFactor: Number(process.env.DPR),
    mobile: false,
  })
}
else {
  await send('Emulation.clearDeviceMetricsOverride')
}
await send('Page.navigate', { url })
await sleep(5000)
const support = await evaluate(`({ stage: !!document.querySelector('#stage'), viewport: [innerWidth, innerHeight, devicePixelRatio], canvas: [document.querySelector('#stage')?.width, document.querySelector('#stage')?.height] })`)
console.error(JSON.stringify(support))
if (!support.stage) {
  console.error(await evaluate('document.body.innerText.slice(0, 300)'))
  process.exit(2)
}
if (process.env.OPEN_PANEL) {
  await evaluate(`document.querySelector('.lg-tuner-launcher').click()`)
  await sleep(1500)
}
const round = value => value == null ? null : +value.toFixed(1)
for (let i = 1; i <= Number(runsArg); i++) {
  await evaluate(`document.querySelector('aside button').click()`)
  await sleep(9000)
  const json = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
  const metrics = json.metrics
  console.log(JSON.stringify({
    run: i,
    paintMean: round(json.paintInterval.mean),
    paintP50: round(json.paintInterval.p50),
    paintP95: round(json.paintInterval.p95),
    paints: json.draw.count,
    gpuMean: round(json.gpu.mean),
    gpuP95: round(json.gpu.p95),
    canvas: metrics && [metrics.pixelWidth, metrics.pixelHeight],
    megapixels: metrics && +(metrics.pixelWidth * metrics.pixelHeight / 1e6).toFixed(1),
    dpr: metrics && +metrics.dpr.toFixed(3),
    targetDpr: metrics && +metrics.targetDpr.toFixed(3),
    glassDpr: metrics && +metrics.glassDpr.toFixed(3),
    optics: metrics?.optics,
    adaptation: json.adaptation,
    ...(i === Number(runsArg) ? { adaptationLog: json.adaptationLog } : {}),
    bad: json.invalidReasons,
  }))
}
ws.close()
