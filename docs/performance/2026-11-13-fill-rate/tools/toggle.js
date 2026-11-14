(async () => {
  const canvas = document.querySelector('#stage')
  const launcher = document.querySelector('.tuner-launcher')
  const proto = GPUQueue.prototype
  const orig = proto.drawElementImageToTexture
  let upload = 0; let uploads = 0
  proto.drawElementImageToTexture = function (a, b) { const t = performance.now(); orig.call(this, a, b); upload += performance.now() - t; uploads++ }
  const starts = []; const durs = []
  const s = () => starts.push(performance.now())
  const e = () => durs.push(performance.now() - starts.at(-1))
  window.addEventListener('paint', s, { capture: true })
  canvas.addEventListener('paint', e)
  const out = []
  for (let i = 0; i < 6; i++) {
    starts.length = 0; durs.length = 0; upload = 0; uploads = 0
    launcher.click()
    await new Promise(r => setTimeout(r, 900))
    const iv = starts.slice(1).map((v, k) => v - starts[k])
    out.push({ open: launcher.getAttribute('aria-expanded'), n: iv.length, meanIv: +(iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(1), over20: iv.filter(v => v > 20).length, maxIv: +Math.max(...iv).toFixed(0), meanDraw: +(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1), maxDraw: +Math.max(...durs).toFixed(0), uploadMs: +(upload / starts.length).toFixed(1), uploadsPerFrame: +(uploads / starts.length).toFixed(1) })
    await new Promise(r => setTimeout(r, 600))
  }
  window.removeEventListener('paint', s, { capture: true }); canvas.removeEventListener('paint', e)
  proto.drawElementImageToTexture = orig
  return { out, canvas: canvas.width }
})()
