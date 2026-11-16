// 用法: CDP_PORT=9437 node compare.mjs <scroll.html 的地址> <输出 png>
// 停在 600 px，按下玻璃，100 ms 后让页面上的一张图片做 300 ms 的 transform 过渡，再松开；1.5 秒后截图。
// 分别用 ?reuse=0 与 ?reuse=1 运行，比较两张截图。
const [url, file] = process.argv.slice(2)
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
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable')
await send('Page.bringToFront')
await send('Emulation.setDeviceMetricsOverride', { width: 1563, height: 1013, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await sleep(5000)
await evaluate(`(async () => {
  document.querySelector('aside')?.remove()
  document.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 1 })
  document.querySelector('#stage-scroll').scrollTo({ top: 600, behavior: 'instant' })
  await new Promise(r => setTimeout(r, 800))
  const glass = [...document.querySelectorAll('[data-liquid-glass]')].find(e => { const r = e.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight })
  glass.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))
  const img = [...document.querySelectorAll('img')].find(i => { const r = i.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight && !i.closest('[data-liquid-glass]') })
  img.style.transition = 'transform 300ms linear'
  img.style.transform = 'translateX(40px) rotate(3deg)'
  await new Promise(r => setTimeout(r, 150))
  window.dispatchEvent(new PointerEvent('pointerup'))
  return true
})()`)
await sleep(1500)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFile } = await import('node:fs/promises')
await writeFile(file, Buffer.from(shot.result.data, 'base64'))
console.log(file)
ws.close()
