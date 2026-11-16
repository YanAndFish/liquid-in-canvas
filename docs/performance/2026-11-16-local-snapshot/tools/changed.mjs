// 用法: CDP_PORT=9437 node changed.mjs <演示商店或 scroll.html 的地址>
// 在真实舞台上记录 paint 事件的 changedElements，分别触发：只请求重绘、滚动、transform 过渡、改文字、玻璃内的改动。
const [url] = process.argv.slice(2)
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
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
await send('Page.enable')
await send('Page.bringToFront')
await send('Emulation.clearDeviceMetricsOverride')
await send('Page.navigate', { url })
await sleep(5000)
await evaluate(`(() => {
  const canvas = document.querySelector('#stage')
  const root = canvas.firstElementChild
  window.__log = []
  canvas.addEventListener('paint', (event) => {
    const changed = event.changedElements
    window.__log.push(changed === undefined ? 'none' : changed.map(e => e === root ? 'ROOT' : (e.matches('[data-liquid-glass]') ? 'glass' : e.tagName.toLowerCase())).join(','))
  }, true)
  return true
})()`)
async function phase(name, action, wait = 600) {
  await evaluate(`window.__log = []`)
  await evaluate(action)
  await sleep(wait)
  const log = await evaluate(`window.__log`)
  const counts = {}
  for (const entry of log) counts[entry || '(empty)'] = (counts[entry || '(empty)'] ?? 0) + 1
  console.log(JSON.stringify({ phase: name, paints: log.length, changed: counts }))
}
await evaluate(`document.querySelectorAll('video').forEach(v => v.pause())`)
await sleep(800)
await phase('idle', `0`)
await phase('requestPaint x5', `(async () => { const c = document.querySelector('#stage'); for (let i = 0; i < 5; i++) { c.requestPaint(); await new Promise(r => requestAnimationFrame(r)) } })()`)
await phase('scroll (instant, 10 frames)', `(async () => { const s = document.querySelector('#stage-scroll'); for (let i = 0; i < 10; i++) { s.scrollTop += 40; await new Promise(r => requestAnimationFrame(r)) } })()`)
await phase('transform transition on a page element', `(() => { const el = [...document.querySelectorAll('img')].find(i => { const r = i.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight && !i.closest('[data-liquid-glass]') }); if (!el) return 'no img'; el.style.transition = 'transform 400ms linear'; el.style.transform = el.style.transform ? '' : 'translateX(30px)'; return true })()`, 700)
await phase('opacity transition on a page element', `(() => { const el = [...document.querySelectorAll('h1,h2,p')].find(i => { const r = i.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight && !i.closest('[data-liquid-glass]') }); if (!el) return 'no text'; el.style.transition = 'opacity 400ms linear'; el.style.opacity = el.style.opacity === '0.3' ? '1' : '0.3'; return true })()`, 700)
await phase('text change on a page element', `(() => { const el = [...document.querySelectorAll('p')].find(i => { const r = i.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight && !i.closest('[data-liquid-glass]') }); if (!el) return 'no p'; el.textContent += ' x'; return true })()`)
await phase('text change inside glass', `(() => { const g = [...document.querySelectorAll('[data-liquid-glass]')].find(i => { const r = i.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight && i.textContent.trim() }); if (!g) return 'no glass'; const walker = document.createTreeWalker(g, NodeFilter.SHOW_TEXT); const t = walker.nextNode(); if (t) t.data += ' '; return true })()`)
await phase('video play 500ms', `document.querySelector('video')?.play().then(() => 1).catch(() => 0)`, 500)
await evaluate(`document.querySelectorAll('video').forEach(v => v.pause())`)
ws.close()
