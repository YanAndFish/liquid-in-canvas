import { mkdirSync, writeFileSync } from 'node:fs'

const [url, out] = process.argv.slice(2)
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
async function shot(group, name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}/${group}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}
async function capture(name) {
  await sleep(600)
  await shot('shown', name)
  for (const group of ['redrawn', 'redrawn-again']) {
    await evaluate(`document.querySelector('#stage').requestPaint()`)
    await sleep(300)
    await shot(group, name)
  }
}
for (const group of ['shown', 'redrawn', 'redrawn-again'])
  mkdirSync(`${out}/${group}`, { recursive: true })
await send('Page.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: Number(process.env.W ?? 1563), height: Number(process.env.H ?? 1013), deviceScaleFactor: Number(process.env.DPR ?? 2), mobile: false })
await send('Page.navigate', { url })
await sleep(5000)
const times = []
const video = `document.querySelector('video')`
for (let i = 1; i <= 3; i++) {
  await evaluate(`${video}.play().then(() => 1)`)
  await sleep(900 + i * 370)
  await evaluate(`${video}.pause()`)
  await capture(`pause-${i}`)
  times.push(await evaluate(`${video}.currentTime`))
}
for (const time of [1, 4.2]) {
  await evaluate(`new Promise((resolve) => { ${video}.addEventListener('seeked', resolve, { once: true }); ${video}.currentTime = ${time} })`)
  await capture(`seek-${time}`)
}
await evaluate(`new Promise((resolve) => { ${video}.addEventListener('seeked', resolve, { once: true }); ${video}.currentTime = ${video}.duration - 0.5 })`)
await evaluate(`${video}.play().then(() => 1)`)
await sleep(1200)
await evaluate(`${video}.pause()`)
await capture('loop')
times.push(await evaluate(`${video}.currentTime`))
console.log(JSON.stringify({ pausedAt: times }))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
