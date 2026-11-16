// 用法: CDP_PORT=9377 W=2560 H=1440 DPR=3 node trace.mjs "<scroll.html?gpu&adaptive=0&glass=0>" out.json
// 在测量页开始往返滚动 1.5 秒后录 3 秒追踪
import { writeFile } from 'node:fs/promises'
const [url, out] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9377'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find(t => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map(); const events = []; let done
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value)
  if (msg.method === 'Tracing.tracingComplete') done?.()
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 2560), height: Number(process.env.H ?? 1440), deviceScaleFactor: Number(process.env.DPR ?? 3), mobile: false })
await send('Page.navigate', { url }); await sleep(5000)
console.error(JSON.stringify(await evaluate(`[innerWidth, innerHeight, devicePixelRatio, document.querySelector('#stage')?.width, document.querySelector('#stage')?.height]`)))
await evaluate(`document.querySelector('aside button').click()`)
await sleep(1500)
await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['toplevel', 'cc', 'gpu', 'viz', 'blink', 'disabled-by-default-devtools.timeline', 'benchmark', 'disabled-by-default-gpu.service', 'skia'] } })
await sleep(3000)
const complete = new Promise(r => { done = r })
await send('Tracing.end'); await complete
await sleep(6000)
const result = await evaluate(`document.querySelector('#scroll-result')?.textContent`)
await writeFile(out, JSON.stringify(events))
if (result) { const j = JSON.parse(result); const iv = j.intervals ?? j.frameIntervals; console.error('result keys', Object.keys(j).join(','), iv ? (iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(2) : '') }
ws.close()
