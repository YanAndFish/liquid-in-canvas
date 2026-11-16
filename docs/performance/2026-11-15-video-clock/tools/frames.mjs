const [url, runsArg = '1'] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
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
async function taskSeconds() {
  const r = await send('Performance.getMetrics')
  return r.result.metrics.find(metric => metric.name === 'TaskDuration').value
}
await send('Page.enable')
await send('Performance.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR ?? 2), mobile: false })
const out = []
for (let i = 0; i < Number(runsArg); i++) {
  await send('Page.navigate', { url })
  await sleep(5000)
  await evaluate(`(() => {
    const counts = window.__counts = { paint: 0, video: 0, frame: 0, sameFrame: 0, skipped: 0 }
    const canvas = document.querySelector('#stage')
    const video = document.querySelector('video')
    let videoAt = -1
    canvas.addEventListener('paint', () => {
      counts.paint++
      if (videoAt >= 0 && performance.now() - videoAt < 12)
        counts.sameFrame++
      videoAt = -1
    })
    const native = window.requestAnimationFrame
    window.requestAnimationFrame = callback => native.call(window, (time) => { counts.frame++; callback(time) })
    let presented = null
    const onVideoFrame = (now, metadata) => {
      counts.video++
      if (presented !== null && metadata.presentedFrames - presented > 1)
        counts.skipped += metadata.presentedFrames - presented - 1
      presented = metadata.presentedFrames
      videoAt = performance.now()
      video.requestVideoFrameCallback(onVideoFrame)
    }
    video.requestVideoFrameCallback(onVideoFrame)
    return video.play().then(() => 1)
  })()`)
  await sleep(1500)
  const before = JSON.parse(await evaluate(`JSON.stringify(window.__counts)`))
  const taskBefore = await taskSeconds()
  await sleep(4000)
  const after = JSON.parse(await evaluate(`JSON.stringify(window.__counts)`))
  const taskAfter = await taskSeconds()
  await evaluate(`document.querySelector('video').pause()`)
  await sleep(500)
  const paused = JSON.parse(await evaluate(`JSON.stringify(window.__counts)`))
  await sleep(2000)
  const idle = JSON.parse(await evaluate(`JSON.stringify(window.__counts)`))
  out.push({
    paints: after.paint - before.paint,
    videoFrames: after.video - before.video,
    paintInVideoFrame: after.sameFrame - before.sameFrame,
    skippedVideoFrames: after.skipped - before.skipped,
    animationFrames: after.frame - before.frame,
    mainThreadMs: +((taskAfter - taskBefore) * 1000).toFixed(0),
    pausedPaints: idle.paint - paused.paint,
    pausedAnimationFrames: idle.frame - paused.frame,
  })
}
console.log(JSON.stringify(out))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
