// 最小 CDP 驱动：连接远程调试端口的页面，执行测量并输出 JSON。
// 用法: node cdp.mjs <url> <runs> [extra]
const [url, runsArg = '1', mode = ''] = process.argv.slice(2)
const port = process.env.CDP_PORT ?? '9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  let page = list.find(t => t.type === 'page')
  if (!page)
    page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  return page
}

const target = await pageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
function send(method, params = {}) {
  return new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

await send('Page.enable')
await send('Page.bringToFront')
await send('Page.navigate', { url })
await sleep(6000)
const support = await evaluate(`({ stage: !!document.querySelector('#stage'), viewport: [innerWidth, innerHeight, devicePixelRatio], ua: navigator.userAgent })`)
console.error(JSON.stringify(support))
if (!support.stage) {
  console.error(await evaluate('document.body.innerText.slice(0, 300)'))
  process.exit(2)
}
const runs = Number(runsArg)
const results = []
// 第一轮预热，不计入。
for (let i = 0; i <= runs; i++) {
  await evaluate(`document.querySelector('aside button').click()`)
  await sleep(9000)
  const text = await evaluate(`document.querySelector('#scroll-result').textContent`)
  const json = JSON.parse(text)
  if (i > 0) {
    if (mode !== 'full') {
      delete json.gpuPassTimes
      delete json.gpuPassInfo
    }
    results.push(json)
  }
}
console.log(JSON.stringify(results))
ws.close()
