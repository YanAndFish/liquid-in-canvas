import type { GlassRenderMode, LiquidGlassMount, StageFault, StageResolution } from 'liquid-in-canvas'
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

  const controller: RendererController = {
    mode,
    canvasSupported: support.supported,
    svgSupported: supportsSvgBackdropFilter(),
    switching,
    error,
    resolution,
    metrics: () => mount?.stage?.getMetrics() ?? null,
    setMode,
    setResolution(patch) {
      resolution.value = {
        ...resolution.value,
        ...patch,
      }
      mount?.stage?.setResolution(patch)
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

  /** 画布不可用或出错时显示说明页。是否改用回退实现由用户在页面上决定。 */
  function showNotice(fault: StageFault): void {
    teardown()
    notice = createApp(UnsupportedView, {
      fault,
      onContinue: () => {
        // 请求 SVG 滤镜回退；浏览器不支持时库会自动使用纯 CSS。
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
      // 画布模式下应用要在根元素移入画布之后、开始绘制之前挂载，前景层才能被舞台找到。
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

  /** 在应用保持挂载的情况下更换渲染方式，保留滚动位置和视频播放状态。 */
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
    // 根元素在文档中移动后，滚动位置归零，视频也会被暂停。
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
