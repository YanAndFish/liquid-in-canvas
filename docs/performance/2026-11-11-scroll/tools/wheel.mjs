// 真实滚轮测量：视频保持播放，CDP 发送滚轮事件，统计画布 paint 间隔与绘制同步耗时。
// 用法: node wheel.mjs <url> <runs> [--pause-video] [--trace out.json]
const [url, runsArg = '3', ...flags] = process.argv.slice(2)
const pauseVideo = flags.includes('--pause-video')
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
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}
await send('Page.enable')
await send('Page.bringToFront')
await send('Page.navigate', { url })
await sleep(6000)
const ok = await evaluate(`!!document.querySelector('#stage')`)
if (!ok) { console.error('no stage'); process.exit(2) }
// 隐藏测量面板，避免遮挡。
await evaluate(`document.querySelector('aside')?.remove(); true`)
await evaluate(`(() => {
  const canvas = document.querySelector('#stage')
  window.__m = { on: false, starts: [], ends: [], frames: [] }
  window.addEventListener('paint', () => { if (__m.on) __m.starts.push(performance.now()) }, { capture: true })
  canvas.addEventListener('paint', () => { if (__m.on) __m.ends.push(performance.now()) })
  const loop = t => { if (__m.on) __m.frames.push(t); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  return true
})()`)
const W = 1563; const H = 1013
async function wheelRun() {
  const scroller = `document.getElementById('stage-scroll')`
  await evaluate(`${scroller}.scrollTo({ top: 0, behavior: 'instant' }); true`)
  if (pauseVideo)
    await evaluate(`document.querySelectorAll('video').forEach(v => v.pause()); true`)
  else await evaluate(`Promise.all([...document.querySelectorAll('video')].map(v => v.play().catch(() => {}))).then(() => true)`)
  await sleep(800)
  await evaluate(`Object.assign(__m, { on: true, starts: [], ends: [], frames: [] }); true`)
  const t0 = Date.now()
  // 3 秒向下、3 秒向上，每 16ms 一次 40px，近似触控板连续滚动。
  for (const dir of [1, -1]) {
    const end = Date.now() + 3000
    while (Date.now() < end) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: W / 2,
        y: H / 2,
        deltaX: 0,
        deltaY: 40 * dir,
      })
      await sleep(16)
    }
  }
  await sleep(300)
  const r = await evaluate(`(() => {
    __m.on = false
    const s = __m.starts, e = __m.ends, f = __m.frames
    const iv = a => a.slice(1).map((v, i) => v - a[i])
    const dur = e.map((v, i) => v - (s[i] ?? v))
    const stats = a => { const b = [...a].sort((x, y) => x - y); return { n: b.length, mean: +(b.reduce((x, y) => x + y, 0) / (b.length || 1)).toFixed(2), p50: +(b[b.length >> 1] ?? 0).toFixed(2), p95: +(b[Math.floor(b.length * .95)] ?? 0).toFixed(2), max: +(b.at(-1) ?? 0).toFixed(2) } }
    const pi = iv(s)
    return { paints: s.length, paintInterval: stats(pi), over33: pi.filter(x => x > 33.4).length, over50: pi.filter(x => x > 50).length, draw: stats(dur), longDraws: dur.filter(x => x > 16).map(x => +x.toFixed(1)), longPaints: pi.filter(x => x > 50).map(x => +x.toFixed(1)), raf: stats(iv(f)), rafOver33: iv(f).filter(x => x > 33.4).length,
      maxScroll: document.getElementById('stage-scroll').scrollTop, video: [...document.querySelectorAll('video')].map(v => !v.paused) }
  })()`)
  r.wallMs = Date.now() - t0
  return r
}
const runs = Number(runsArg)
const out = []
const profile = flags.includes('--profile')
if (profile) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 }) }
if (!flags.includes('--cold'))
  await wheelRun() // 预热
if (profile)
  await send('Profiler.start')
for (let i = 0; i < runs; i++) out.push(await wheelRun())
if (profile) { const p = await send('Profiler.stop'); (await import('node:fs')).writeFileSync(flags[flags.indexOf('--profile') + 1], JSON.stringify(p.result.profile)) }
console.log(JSON.stringify(out))
ws.close()
