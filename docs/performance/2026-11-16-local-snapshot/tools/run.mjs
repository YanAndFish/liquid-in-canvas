// 用法:
//   CDP_PORT=9437 [W=.. H=.. DPR=..] node run.mjs probe <subrect.html 的地址>
//   CDP_PORT=9437 [W=.. H=.. DPR=..] RUNS=2 node run.mjs scroll <scroll.html 的地址>
// probe：打开探针页，等它测完，输出 #result 里的 JSON。
// scroll：打开 tests/perf/scroll.html，预热一轮后点击测量按钮 RUNS 次，每轮输出一行摘要。
const [kind, url] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9437'
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
if (process.env.DPR)
  await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR), mobile: false })
else
  await send('Emulation.clearDeviceMetricsOverride')
await send('Page.navigate', { url })

if (kind === 'probe') {
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const text = await evaluate(`document.querySelector('#result')?.textContent ?? ''`)
    if (text.startsWith('{') || (text && !text.startsWith('准备'))) {
      console.log(text.startsWith('{') ? JSON.stringify(JSON.parse(text)) : text)
      break
    }
  }
}
else {
  await sleep(5000)
  const runs = Number(process.env.RUNS ?? 2)
  for (let i = 0; i <= runs; i++) {
    await evaluate(`document.querySelector('aside button').click()`)
    await sleep(9000)
    const json = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
    if (i === 0)
      continue
    console.log(JSON.stringify({
      paints: json.draw.count,
      drawCpu: +json.draw.mean.toFixed(2),
      paintMean: +json.paintInterval.mean?.toFixed(2),
      paintP95: +json.paintInterval.p95?.toFixed(2),
      gpuMean: json.gpu.mean === null ? null : +json.gpu.mean.toFixed(2),
      gpuP95: json.gpu.p95 === null ? null : +json.gpu.p95.toFixed(2),
      uploads: json.uploads,
      canvas: json.metrics && [json.metrics.pixelWidth, json.metrics.pixelHeight, +json.metrics.dpr.toFixed(2), +json.metrics.glassDpr.toFixed(2), json.metrics.optics],
      bad: json.invalidReasons,
    }))
  }
}
ws.close()
