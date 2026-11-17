import type { GlassOptics, GlassRenderMode, LiquidGlassMount, StageFault, StageResolution } from 'liquid-in-canvas'
import type { App } from 'vue'
import type { RendererController } from './composables/useRenderer'
import { DEFAULT_STAGE_RESOLUTION, detectStageSupport, mountLiquidGlass, supportsSvgBackdropFilter } from 'liquid-in-canvas'
import { createApp, ref } from 'vue'
import Storefront from './App.vue'
import { RENDERER_KEY } from './composables/useRenderer'
import UnsupportedView from './pages/UnsupportedView.vue'
import { router } from './router'
import { getStageScroller } from './shared/scroll'
import { CART_KEY, createCartStore } from './stores/cart'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './styles/main.css'

function boot(): void {
  const support = detectStageSupport()
  const found = document.querySelector<HTMLDivElement>('#app')

  if (!found)
    throw new Error('Missing #app mount point')

  const host = found
  let notice: App | null = null
  let storefront: App | null = null
  let mount: LiquidGlassMount | null = null

  const mode = ref<GlassRenderMode>('canvas')
  const switching = ref(false)
  const error = ref('')
  const resolution = ref<StageResolution>({ ...DEFAULT_STAGE_RESOLUTION })
  const optics = ref<GlassOptics>('hybrid')

  const controller: RendererController = {
    mode,
    canvasSupported: support.supported,
    svgSupported: supportsSvgBackdropFilter(),
    switching,
    error,
    resolution,
    optics,
    metrics: () => mount?.stage?.getMetrics() ?? null,
    setMode,
    setResolution(patch) {
      resolution.value = {
        ...resolution.value,
        ...patch,
      }
      mount?.stage?.setResolution(patch)
    },
    setOptics(next) {
      optics.value = next
      mount?.stage?.setOptics(next)
    },
  }

  function teardown(): void {
    storefront?.unmount()
    storefront = null
    mount?.dispose()
    mount = null
    notice?.unmount()
    notice = null
    host.replaceChildren()
  }

  function showNotice(fault: StageFault): void {
    teardown()
    notice = createApp(UnsupportedView, {
      fault,
      onContinue: () => {
        void startStore('svg')
      },
    })
    notice.mount(host)
  }

  function attach(next: GlassRenderMode, beforeStart?: () => void): Promise<LiquidGlassMount> {
    return mountLiquidGlass({
      root: host,
      mode: next,
      canvasId: 'stage',
      canvasClass: 'stage-canvas',
      resolution: resolution.value,
      optics: optics.value,
      beforeStart,
      onFault: showNotice,
    })
  }

  async function startStore(next: GlassRenderMode): Promise<void> {
    teardown()
    const app = createApp(Storefront)
    app.use(router)
    app.provide(CART_KEY, createCartStore())
    app.provide(RENDERER_KEY, controller)
    try {
      mount = await attach(next, () => {
        app.mount(host)
        storefront = app
      })
      mode.value = mount.mode
    }
    catch (cause) {
      showNotice({ kind: 'init', support, cause })
    }
  }

  async function setMode(next: GlassRenderMode): Promise<void> {
    if (switching.value || !mount || next === mode.value)
      return
    if (next === 'canvas' && !support.supported)
      return
    switching.value = true
    error.value = ''
    const top = getStageScroller()?.scrollTop ?? 0
    const playing = [
      ...host.querySelectorAll('video'),
    ].filter(video => !video.paused)
    mount.dispose()
    mount = null
    try {
      mount = await attach(next)
    }
    catch (cause) {
      error.value = cause instanceof Error
        ? cause.message
        : String(cause)
      mount = await attach('svg')
    }
    mode.value = mount.mode
    getStageScroller()?.scrollTo({ top, behavior: 'instant' })
    for (const video of playing)
      void video.play().catch(() => {})
    switching.value = false
  }

  if (support.supported)
    void startStore('canvas')
  else
    showNotice({ kind: 'unsupported', support })
}

boot()
