// 在页面里执行：每个显示帧改一次左上角的小方块，统计 3 秒内画布 paint 事件的平均间隔。
// window.__HIDE__ = 'media' 隐藏视频与图片，'all' 隐藏根元素的全部子元素（只剩根元素背景）。
(async () => {
  const hide = window.__HIDE__
  const app = document.querySelector('#app') ?? document.querySelector('[drawable]')
  if (hide === 'all') for (const e of app.children) e.style.visibility = 'hidden'
  if (hide === 'media') for (const e of app.querySelectorAll('video, img, picture')) e.style.visibility = 'hidden'
  const tick = document.createElement('div')
  tick.style.cssText = 'position:fixed;left:4px;top:4px;width:8px;height:8px;background:#888;z-index:99'
  app.append(tick)
  const canvas = document.querySelector('canvas')
  const stamps = []
  canvas.addEventListener('paint', () => stamps.push(performance.now()))
  let run = true; let n = 0
  const step = () => { if (!run) return; tick.style.transform = `translateX(${(n++ % 2)}px)`; requestAnimationFrame(step) }
  requestAnimationFrame(step)
  await new Promise(r => setTimeout(r, 3000))
  run = false
  const iv = stamps.slice(5).map((t, i, a) => i ? t - a[i - 1] : 0).slice(1)
  return { paints: stamps.length, mean: +(iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(1) }
})()
