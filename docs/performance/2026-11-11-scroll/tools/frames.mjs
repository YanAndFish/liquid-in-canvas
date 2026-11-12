// 在固定视频帧和滚动位置截图，用于画面对比。用法: node frames.mjs <url> <outPrefix>
const [url, prefix] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
const evaluate = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
const fs = await import('node:fs')
await send('Page.enable'); await send('Page.bringToFront')
for (const top of [0, 1100, 2300, 3400]) {
  await send('Page.navigate', { url }); await sleep(6000)
  await evaluate(`document.querySelector('aside')?.remove(); true`)
  await evaluate(`Promise.all([...document.querySelectorAll('video')].map(v => { v.pause(); v.currentTime = 1; return new Promise(r => v.addEventListener('seeked', r, { once: true })) })).then(() => true)`)
  await evaluate(`(() => { const el = document.getElementById('stage-scroll'); el.style.scrollBehavior = 'auto'; el.scrollTop = ${top}; return true })()`)
  await sleep(1500)
  console.log(top, await evaluate(`JSON.stringify([document.getElementById('stage-scroll').scrollTop, document.getElementById('stage-scroll').scrollHeight])`))
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`${prefix}-${top}.png`, Buffer.from(r.result.data, 'base64'))
}
console.log(await evaluate(`JSON.stringify({ err: document.querySelector('#stage') ? 'ok' : 'fallback' })`))
ws.close()
