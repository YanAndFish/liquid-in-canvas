// 点击标签组中的一项，连续截取激活玻璃流向新位置的过程。
// 用法: node morph.mjs <页面地址> <按钮选择器> <输出目录>
import { mkdir, writeFile } from 'node:fs/promises'

const [url, selector, outDir] = process.argv.slice(2)
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
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) logs.push(msg.params.args.map(a => a.value ?? a.description).join(' '))
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
await mkdir(outDir, { recursive: true })
await send('Page.enable')
await send('Runtime.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: 1563, height: 1013, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url })
await sleep(4500)
const scroll = Number(process.env.SCROLL ?? 0)
await evaluate(`(async () => { document.querySelector('aside')?.style.setProperty('display', 'none'); for (const v of document.querySelectorAll('video')) v.pause(); document.getElementById('stage-scroll')?.scrollTo({ top: ${scroll}, behavior: 'instant' }); return 1 })()`)
await sleep(1500)
const box = await evaluate(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})]; const r = all[0].parentElement.getBoundingClientRect(); return { x: r.left - 24, y: r.top - 24, width: r.width + 48, height: r.height + 48, count: all.length } })()`)
const clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
const index = Number(process.env.INDEX ?? box.count - 1)
await evaluate(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].click()`)
const start = Date.now()
for (let i = 0; i < 14; i++) {
  const r = await send('Page.captureScreenshot', { format: 'png', clip })
  await writeFile(`${outDir}/frame-${String(i).padStart(2, '0')}-${Date.now() - start}ms.png`, Buffer.from(r.result.data, 'base64'))
}
await sleep(900)
const r = await send('Page.captureScreenshot', { format: 'png', clip })
await writeFile(`${outDir}/frame-final.png`, Buffer.from(r.result.data, 'base64'))
console.log(JSON.stringify({ box, logs }))
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
