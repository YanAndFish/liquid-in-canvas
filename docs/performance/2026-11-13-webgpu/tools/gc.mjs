// 用法: node gc.mjs <页面地址>  在第二轮 8 秒滚动期间记录 GC 与分配
const [url] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const target = list.find(t => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const events = []
let traceDone
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value)
  if (msg.method === 'Tracing.tracingComplete') traceDone()
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: 1563, height: 1013, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(5000)
const run = async () => { await evaluate(`document.querySelector('aside button').click()`); await sleep(8600) }
await run()
await send('HeapProfiler.enable')
await send('HeapProfiler.collectGarbage')
await send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc'] }, transferMode: 'ReportEvents' })
await send('HeapProfiler.startSampling', { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
await run()
const { result: { profile } } = await send('HeapProfiler.stopSampling')
const done = new Promise(r => { traceDone = r })
await send('Tracing.end')
await done
const result = JSON.parse(await evaluate(`document.querySelector('#scroll-result').textContent`))
const paints = result.draw.count
// GC 停顿：只统计渲染进程主线程上的事件
const gcs = {}
for (const e of events) {
  if (e.ph !== 'X' || !/^(MinorGC|MajorGC|V8\.GC_SCAVENGER|V8\.GC_MC_BACKGROUND|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCIncrementalMarking)$/.test(e.name)) continue
  const g = gcs[e.name] ??= { n: 0, totalMs: 0, maxMs: 0 }
  g.n++; g.totalMs += e.dur / 1000; g.maxMs = Math.max(g.maxMs, e.dur / 1000)
}
for (const g of Object.values(gcs)) { g.totalMs = +g.totalMs.toFixed(2); g.maxMs = +g.maxMs.toFixed(2) }
// 分配：按调用栈中是否经过渲染器分块归类
let total = 0; let renderer = 0
const byFn = new Map()
function walk(node, inRenderer, path) {
  const frame = node.callFrame
  const here = inRenderer || frame.url.includes('CanvasStage')
  total += node.selfSize
  if (here) {
    renderer += node.selfSize
    const key = `${frame.functionName || '(anonymous)'} @${frame.url.split('/').pop()}:${frame.lineNumber}`
    const top = frame.url.includes('CanvasStage') ? key : `${path} → ${key}`
    byFn.set(top, (byFn.get(top) ?? 0) + node.selfSize)
  }
  const label = frame.url.includes('CanvasStage') ? `${frame.functionName || '(anonymous)'}:${frame.lineNumber}` : path
  for (const child of node.children) walk(child, here, label)
}
walk(profile.head, false, '')
const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, `${(v / paints / 1024).toFixed(1)} KB/帧`])
console.log(JSON.stringify({ url, paints, paintMean: +result.paintInterval.mean.toFixed(2), paintP95: +result.paintInterval.p95.toFixed(1), paintMax: +result.paintInterval.max.toFixed(1), allocTotalMB: +(total / 1048576).toFixed(1), rendererMB: +(renderer / 1048576).toFixed(1), rendererKBPerFrame: +(renderer / paints / 1024).toFixed(1), gc: gcs, top }, null, 1))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
