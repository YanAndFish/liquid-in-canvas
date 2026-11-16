import type { GlassOptics, GlassRenderMode } from 'liquid-in-canvas'
import type { RendererController } from '@/composables/useRenderer'
import { mount } from '@vue/test-utils'
import { DEFAULT_STAGE_RESOLUTION, getGlassDefaults, resetGlassDefaults } from 'liquid-in-canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import GlassTuner from '@/components/tuner/GlassTuner.vue'
import { RENDERER_KEY } from '@/composables/useRenderer'

const locale = ref<'zh' | 'en'>('zh')
vi.mock('@/composables/useLocale', () => ({
  useLocale: () => ({ locale }),
}))

/** 创建不接触 GPU 的渲染控制器，记录面板发出的调用。 */
function createRenderer(): RendererController {
  const mode = ref<GlassRenderMode>('canvas')
  const resolution = ref({ ...DEFAULT_STAGE_RESOLUTION })
  const optics = ref<GlassOptics>('profile')
  return {
    mode,
    canvasSupported: true,
    svgSupported: true,
    switching: ref(false),
    error: ref(''),
    resolution,
    optics,
    metrics: () => null,
    setMode: vi.fn(async (next) => {
      mode.value = next
    }),
    setResolution: vi.fn((patch) => {
      resolution.value = {
        ...resolution.value,
        ...patch,
      }
    }),
    setOptics: vi.fn((next) => {
      optics.value = next
    }),
  }
}

function mountTuner(renderer: RendererController | null = createRenderer()) {
  return mount(GlassTuner, {
    attachTo: document.body,
    global: {
      provide: renderer
        ? { [RENDERER_KEY as symbol]: renderer }
        : {},
    },
  })
}

let wrapper: ReturnType<typeof mountTuner>
afterEach(() => {
  wrapper.unmount()
  locale.value = 'zh'
  resetGlassDefaults()
})

function launcher(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.lg-tuner-launcher')!
}

describe('调参面板（库组件的 Vue 封装）', () => {
  it('把库的面板插入组件位置，卸载时移除', () => {
    wrapper = mountTuner()
    expect(wrapper.element.querySelector('.lg-tuner')).not.toBeNull()
    wrapper.unmount()
    expect(document.querySelector('.lg-tuner')).toBeNull()
    wrapper = mountTuner()
  })

  it('滑块修改全局默认值', () => {
    wrapper = mountTuner()
    launcher().click()
    const input = document.querySelector<HTMLInputElement>('input[data-field="fusion"]')!
    input.value = '64'
    input.dispatchEvent(new Event('input'))
    expect(getGlassDefaults().fusion).toBe(64)
  })

  it('购物袋打开时关闭并隐藏面板', async () => {
    wrapper = mountTuner()
    launcher().click()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await wrapper.setProps({ disabled: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.lg-tuner')!.hasAttribute('data-hidden')).toBe(true)
  })

  it('跟随应用语言', async () => {
    wrapper = mountTuner()
    expect(launcher().getAttribute('aria-label')).toBe('玻璃调参')
    locale.value = 'en'
    await nextTick()
    expect(launcher().getAttribute('aria-label')).toBe('Glass tuning')
  })

  it('通过渲染控制器切换渲染方式', async () => {
    const renderer = createRenderer()
    wrapper = mountTuner(renderer)
    launcher().click()
    document.querySelector<HTMLButtonElement>('button[data-mode="css"]')!.click()
    expect(renderer.setMode).toHaveBeenCalledWith('css')
    await nextTick()
    expect(document.querySelector('button[data-mode="css"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('控制器在面板之外变化时同步', async () => {
    const optics = ref<GlassOptics>('profile')
    wrapper = mountTuner({
      ...createRenderer(),
      optics,
    })
    launcher().click()
    optics.value = 'hybrid'
    await nextTick()
    expect(document.querySelector('[data-optics="hybrid"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('没有渲染控制器时隐藏渲染方式一节', () => {
    wrapper = mountTuner(null)
    launcher().click()
    expect(document.querySelector('[data-section="renderer"]')!.hasAttribute('hidden')).toBe(true)
  })
})
