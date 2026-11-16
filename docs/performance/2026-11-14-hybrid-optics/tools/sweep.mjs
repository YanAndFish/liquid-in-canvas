import { mkdir, writeFile } from 'node:fs/promises'

const [base, outDir] = process.argv.slice(2)
const optics = process.env.OPTICS ?? 'hybrid'
const port = process.env.CDP_PORT ?? '9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find(t => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Runtime.exceptionThrown') logs.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(msg.params.args.map(a => a.value ?? a.description).join(' '))
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
async function shot(name) {
  await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`)
  await sleep(700)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${outDir}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}
await mkdir(outDir, { recursive: true })
await send('Page.enable')
await send('Runtime.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1150, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: 'about:blank' })
await sleep(300)
await send('Page.navigate', { url: `${base}/tests/visual/liquid-glass.html?optics=${optics}` })
await sleep(4500)
const set = (id, value) => `(() => { const el = document.getElementById('${id}'); el.value = '${value}'; el.dispatchEvent(new Event('input', { bubbles: true })) })()`
for (let gap = -80; gap <= 56; gap += 8) {
  await evaluate(set('gap', gap))
  await shot(`gap-${String(gap + 80).padStart(3, '0')}`)
}
await evaluate(set('gap', 12))
const clip = (top, height, name) => `(() => {
  let box = document.getElementById('clip-box')
  const glass = document.querySelector('.anchor.c')
  if (!box) {
    box = document.createElement('div')
    box.id = 'clip-box'
    box.setAttribute('data-glass-clip', '')
    document.getElementById('app').append(box)
    box.append(glass)
  }
  box.style.cssText = 'position:absolute;left:300px;width:400px;overflow:clip;top:${top}px;height:${height}px'
  glass.style.left = '-120px'
  glass.style.top = (485 - ${top}) + 'px'
  return '${name}'
})()`
for (const [top, height, name] of [[440, 240, 'clip-sides'], [520, 160, 'clip-top'], [440, 120, 'clip-bottom']]) {
  await evaluate(clip(top, height, name))
  await sleep(2500)
  await shot(name)
}
console.log(JSON.stringify({ optics, logs }))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
