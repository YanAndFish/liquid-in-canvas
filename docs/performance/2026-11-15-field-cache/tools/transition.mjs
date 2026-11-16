// 录制“滚动 → 停下 → 再次滚动”过程中的每一帧，用来衡量折射场缓存在查表与求交之间切换时画面的跳变。
// 用法: [CDP_PORT=9333] [FROM=560] [TO=600] [STEP=2] [HOLD=700] [ROI=x,y,w,h] node transition.mjs <页面地址> <输出目录>
// 页面是 tests/perf/scroll.html 的构建结果，带 ?adaptive=0&optics=…。滚动由帧序号驱动：每个动画帧移动 STEP 像素，
// 从 FROM 到 TO，停 HOLD 毫秒，再同样移动一段。每次画布绘制之后截取画布的 ROI（画布像素，缺省整幅），
// 连同时间与滚动位置写进输出目录：frames.json 与 NNN.png。对每种光路各录一次，再用 transition_diff.py 比较。
import { mkdir, writeFile } from 'node:fs/promises'

const [url, outDir] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9333'
const from = Number(process.env.FROM ?? 560)
const to = Number(process.env.TO ?? 600)
const step = Number(process.env.STEP ?? 2)
const hold = Number(process.env.HOLD ?? 700)
const roi = process.env.ROI ? process.env.ROI.split(',').map(Number) : null
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
await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR ?? 2), mobile: false })
await send('Page.navigate', { url: 'about:blank' })
await sleep(300)
await send('Page.navigate', { url })
await sleep(4500)
// 暂停视频并定位到第 1 秒，隐藏测量面板：背景不变，帧与帧之间的差别只来自玻璃。
const ready = await evaluate(`(async () => {
  document.querySelector('aside')?.style.setProperty('display', 'none')
  for (const video of document.querySelectorAll('video')) {
    video.pause()
    await new Promise((resolve) => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 1; setTimeout(resolve, 1500) })
  }
  document.getElementById('stage-scroll').scrollTo({ top: ${from}, behavior: 'instant' })
  return !!document.querySelector('#stage')
})()`)
if (!ready) throw new Error('画布没有启动')
await sleep(2500)
const count = await evaluate(`(async () => {
  const canvas = document.querySelector('#stage')
  const scroller = document.getElementById('stage-scroll')
  const roi = ${JSON.stringify(roi)} ?? [0, 0, canvas.width, canvas.height]
  const frames = []
  let recording = true
  // 舞台的绘制监听先注册，这里在它画完之后截取。
  canvas.addEventListener('paint', () => {
    if (recording)
      frames.push({ time: performance.now(), top: scroller.scrollTop, bitmap: createImageBitmap(canvas, roi[0], roi[1], roi[2], roi[3]) })
  })
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const travel = async (start) => {
    const steps = Math.round(${(to - from) / step})
    for (let i = 1; i <= steps; i++) {
      await frame()
      scroller.scrollTo({ top: start + i * ${step}, behavior: 'instant' })
    }
  }
  const marks = { start: performance.now() }
  await travel(${from})
  marks.stop = performance.now()
  await sleep(${hold})
  marks.resume = performance.now()
  await travel(${to})
  marks.end = performance.now()
  await sleep(${hold})
  recording = false
  window.__transition = { frames, marks, roi }
  return frames.length
})()`)
const marks = await evaluate('window.__transition.marks')
const frames = []
for (let i = 0; i < count; i++) {
  const data = await evaluate(`(async () => {
    const item = window.__transition.frames[${i}]
    const bitmap = await item.bitmap
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let text = ''
    for (let k = 0; k < bytes.length; k += 32768) text += String.fromCharCode(...bytes.subarray(k, k + 32768))
    return { time: item.time, top: item.top, png: btoa(text) }
  })()`)
  const name = `${String(i).padStart(3, '0')}.png`
  await writeFile(`${outDir}/${name}`, Buffer.from(data.png, 'base64'))
  frames.push({ file: name, time: data.time, top: data.top })
}
await writeFile(`${outDir}/frames.json`, JSON.stringify({ url, from, to, step, hold, roi, marks, frames }, null, 2))
console.log(JSON.stringify({ frames: frames.length, marks }))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
