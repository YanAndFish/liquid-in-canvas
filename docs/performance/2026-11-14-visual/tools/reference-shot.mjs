// 截取 tests/visual/reference.html 的场景，同时记下玻璃轮廓与分界线，供 profile_fit.py 使用。
// 用法: node reference-shot.mjs <站点根地址> <输出目录> [场景…]
// 场景缺省为 capsule；可写成 `capsule:split=-0.3&refraction=30`，冒号后的参数追加到页面地址。
// 环境变量 CDP_PORT 指定隔离 Chrome 的调试端口（缺省 9333），QUERY 追加到每个页面的查询参数。
import { mkdir, writeFile } from 'node:fs/promises'

const [base, outDir, ...scenes] = process.argv.slice(2)
if (!base || !outDir) {
  console.error('用法: node reference-shot.mjs <站点根地址> <输出目录> [场景…]')
  process.exit(1)
}
const port = process.env.CDP_PORT ?? '9333'
const width = Number(process.env.W ?? 1563)
const height = Number(process.env.H ?? 1013)
const dpr = Number(process.env.DPR ?? 2)
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
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })

for (const spec of scenes.length ? scenes : ['capsule']) {
  const [scene, extra = ''] = spec.split(':')
  const params = new URLSearchParams(`scene=${scene}&panel=0&adaptive=0&maxPixelRatio=${dpr}&maxGlassPixelRatio=${dpr}`)
  for (const [k, v] of new URLSearchParams(extra)) params.set(k, v)
  for (const [k, v] of new URLSearchParams(process.env.QUERY ?? '')) params.set(k, v)
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(300)
  await send('Page.navigate', { url: `${base}/tests/visual/reference.html?${params}` })
  await sleep(3000)
  const state = await evaluate(`(async () => {
    for (let i = 0; i < 100 && !window.reference?.ready; i++) await new Promise(r => setTimeout(r, 100))
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    return window.reference
  })()`)
  if (!state?.ready) throw new Error(`${spec}：画布没有启动`)
  await sleep(900)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const name = extra ? `${scene}-${extra.replace(/[^\w.-]+/g, '_')}` : scene
  await writeFile(`${outDir}/${name}.png`, Buffer.from(shot.result.data, 'base64'))
  await writeFile(`${outDir}/${name}.json`, `${JSON.stringify({ query: params.toString(), dpr, ...state }, null, 2)}\n`)
  console.error(`saved ${name}`)
  if (state.boundary)
    console.log(`python3 -I profile_fit.py measure ${outDir}/${name}.png --page ${outDir}/${name}.json --curve ${outDir}/${name}-curve.csv --out ${outDir}/${name}-samples.csv`)
}
await send('Emulation.clearDeviceMetricsOverride')
ws.close()
