(async () => {
  const canvas = document.querySelector('#stage')
  const times = []
  const on = () => times.push(performance.now())
  canvas.addEventListener('paint', on)
  const raf = []
  let run = true
  const loop = t => { raf.push(t); if (run) requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  await new Promise(r => setTimeout(r, 4000))
  run = false
  canvas.removeEventListener('paint', on)
  const iv = a => a.slice(1).map((v, i) => v - a[i])
  const st = a => { const b = [...a].sort((x, y) => x - y); return { n: b.length, mean: +(b.reduce((x, y) => x + y, 0) / (b.length || 1)).toFixed(2), p50: +(b[b.length >> 1] ?? 0).toFixed(1), p95: +(b[Math.floor(b.length * 0.95)] ?? 0).toFixed(1), max: +(b.at(-1) ?? 0).toFixed(1) } }
  return { paint: st(iv(times)), raf: st(iv(raf)), canvas: [canvas.width, canvas.height], video: [...document.querySelectorAll('video')].map(v => !v.paused), visible: document.visibilityState, focus: document.hasFocus() }
})()
