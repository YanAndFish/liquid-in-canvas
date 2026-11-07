import type { App } from 'vue'
import type { StageFault } from './stage/types'
import { createApp } from 'vue'
import Storefront from './App.vue'
import UnsupportedView from './pages/UnsupportedView.vue'
import { router } from './router'
import { CanvasStage } from './stage/CanvasStage'
import { detectStageSupport } from './stage/support'
import { CART_KEY, createCartStore } from './stores/cart'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './styles/main.css'

async function boot(): Promise<void> {
  const support = detectStageSupport()
  const found = document.querySelector<HTMLDivElement>('#app')

  if (!found)
    throw new Error('Missing #app mount point')

  const host = found

  function showNotice(fault: StageFault): void {
    host.replaceChildren()
    createApp(UnsupportedView, { fault }).mount(host)
  }

  if (!support.supported) {
    showNotice({ kind: 'unsupported', support })
    return
  }

  const canvas = document.createElement('canvas')
  canvas.id = 'stage'
  canvas.className = 'stage-canvas'
  canvas.setAttribute('content', 'drawable')
  host.before(canvas)

  let storefront: App | null = null
  let stage: CanvasStage | null = null

  function fallBack(cause: unknown): void {
    storefront?.unmount()
    storefront = null
    stage?.dispose()
    stage = null
    canvas.remove()
    if (host.parentElement !== document.body)
      document.body.appendChild(host)
    host.removeAttribute('drawable')
    showNotice({ kind: 'runtime', support, cause })
  }

  stage = new CanvasStage({ canvas, onFault: fallBack })

  try {
    await stage.init()
  }
  catch (cause) {
    canvas.remove()
    stage.dispose()
    stage = null
    showNotice({ kind: 'init', support, cause })
  }

  if (stage) {
    try {
      canvas.appendChild(host)
      const app = createApp(Storefront)
      app.use(router)
      app.provide(CART_KEY, createCartStore())
      app.mount(host)
      storefront = app
      stage.start(host)
    }
    catch (cause) {
      fallBack(cause)
    }
  }
}

void boot()
