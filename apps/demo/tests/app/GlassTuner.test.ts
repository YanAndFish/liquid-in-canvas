import type { GlassOptics, GlassRenderMode } from 'liquid-in-canvas'
import type { RendererController } from '@/composables/useRenderer'
import { mount } from '@vue/test-utils'
import { DEFAULT_STAGE_RESOLUTION, getGlassDefaults, resetGlassDefaults } from 'liquid-in-canvas'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import GlassTuner from '@/components/tuner/GlassTuner.vue'
import { clampLauncherPosition, tunerPanelPosition } from '@/components/tuner/position'
import { RENDERER_KEY } from '@/composables/useRenderer'

vi.mock('@/composables/useLocale', async () => {
  const { ref } = await import('vue')
  return {
    useLocale: () => ({
      isChinese: ref(true),
    }),
  }
})
vi.mock('@/composables/useTheme', async () => {
  const { ref } = await import('vue')
  return {
    useTheme: () => ({
      theme: ref('dark'),
    }),
  }
})

/** 创建不接触 GPU 的渲染控制器，记录面板发出的调用。 */
function createRenderer(canvasSupported = true, svgSupported = true): RendererController {
  const mode = ref<GlassRenderMode>(canvasSupported
    ? 'canvas'
    : svgSupported ? 'svg' : 'css')
  const resolution = ref({ ...DEFAULT_STAGE_RESOLUTION })
  const optics = ref<GlassOptics>('profile')
  return {
    mode,
    canvasSupported,
    svgSupported,
    switching: ref(false),
    error: ref(''),
    resolution,
    optics,
    metrics: () => ({
      cssWidth: 1000,
      cssHeight: 800,
      pixelWidth: 2000,
      pixelHeight: 1600,
      dpr: 2,
      glassDpr: 1.5,
    }),
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
  resetGlassDefaults()
})

describe('调参面板', () => {
  beforeEach(() => {
    wrapper = mountTuner()
  })

  it('点击打开面板后 Escape 关闭并恢复入口焦点', async () => {
    const launcher = wrapper.get('.tuner-launcher')
    launcher.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await nextTick()
    expect(wrapper.get('[role="dialog"]').attributes('inert')).toBeUndefined()
    await wrapper.get('input[data-field="blur"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(launcher.element)
  })

  it('拖动滑块修改当前主题下所选材质的全局默认值', async () => {
    await wrapper.get('.tuner-launcher').trigger('click')
    await wrapper.get('input[data-field="blur"]').setValue('40')
    expect(getGlassDefaults().materials.regular.dark.blur).toBe(40)
    expect(getGlassDefaults().materials.regular.light.blur).toBe(18)
    expect(getGlassDefaults().materials.clear.dark.blur).toBe(2)

    await wrapper.get('button[data-variant="clear"]').trigger('click')
    await wrapper.get('input[data-field="dispersion"]').setValue('0.8')
    expect(getGlassDefaults().materials.clear.dark.dispersion).toBe(0.8)
    expect(getGlassDefaults().materials.regular.dark.dispersion).toBe(0.3)
  })

  it('形体参数与染色写入全局默认值', async () => {
    await wrapper.get('.tuner-launcher').trigger('click')
    await wrapper.get('input[data-field="fusion"]').setValue('64')
    await wrapper.get('input[data-field="tint"]').setValue('#336699')
    expect(getGlassDefaults().fusion).toBe(64)
    expect(getGlassDefaults().materials.regular.dark.tint).toBe('#336699')
  })

  it('恢复默认会还原玻璃参数', async () => {
    await wrapper.get('.tuner-launcher').trigger('click')
    await wrapper.get('input[data-field="blur"]').setValue('40')
    await wrapper.get('button[data-action="reset"]').trigger('click')
    expect(getGlassDefaults().materials.regular.dark.blur).toBe(18)
    expect((wrapper.get('input[data-field="blur"]').element as HTMLInputElement).value).toBe('18')
  })

  it('拖动后产生的点击不会打开面板', async () => {
    const launcher = wrapper.get('.tuner-launcher')
    Object.assign(launcher.element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    })
    launcher.element.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 900,
      clientY: 600,
    }))
    launcher.element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 700, clientY: 400 }))
    launcher.element.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 700, clientY: 400 }))
    launcher.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('.tuner-launcher').attributes('style')).toContain('left: 732px')
  })

  it('购物袋打开时关闭并隐藏面板', async () => {
    await wrapper.get('.tuner-launcher').trigger('click')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('.tuner-root').attributes('style')).toContain('display: none')
  })
})

describe('渲染方式开关', () => {
  it('完整支持的浏览器可以在画布与两种回退之间切换', async () => {
    const renderer = createRenderer()
    wrapper = mountTuner(renderer)
    await wrapper.get('.tuner-launcher').trigger('click')
    expect(wrapper.get('button[data-mode="canvas"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('button[data-mode="css"]').trigger('click')
    expect(renderer.setMode).toHaveBeenCalledWith('css')
    await nextTick()
    expect(wrapper.get('button[data-mode="css"]').attributes('aria-pressed')).toBe('true')
    // 分辨率只对画布有意义，切到回退后隐藏。
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    await wrapper.get('button[data-mode="svg"]').trigger('click')
    expect(renderer.setMode).toHaveBeenCalledWith('svg')
    await nextTick()
    expect(wrapper.text()).toContain('SVG 滤镜回退')
  })

  it('不能把 SVG 滤镜用作背景滤镜的浏览器禁用该选项', async () => {
    wrapper = mountTuner(createRenderer(false, false))
    await wrapper.get('.tuner-launcher').trigger('click')
    expect(wrapper.get('button[data-mode="svg"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button[data-mode="css"]').attributes('aria-pressed')).toBe('true')
  })

  it('显示画布与玻璃着色的实际倍率', async () => {
    wrapper = mountTuner()
    await wrapper.get('.tuner-launcher').trigger('click')
    expect(wrapper.get('[data-role="ratios"]').text()).toContain('2.00×')
    expect(wrapper.get('[data-role="ratios"]').text()).toContain('1.50×')
  })

  it('不支持画布的浏览器禁用画布选项', async () => {
    wrapper = mountTuner(createRenderer(false))
    await wrapper.get('.tuner-launcher').trigger('click')
    expect(wrapper.get('button[data-mode="canvas"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('不能使用画布渲染')
  })

  it('调整渲染倍率上限', async () => {
    const renderer = createRenderer()
    wrapper = mountTuner(renderer)
    await wrapper.get('.tuner-launcher').trigger('click')
    await wrapper.get('[data-section="renderer"] input[type="range"]').setValue('1.5')
    expect(renderer.setResolution).toHaveBeenCalledWith({ maxPixelRatio: 1.5 })
  })

  it('切换三维求交与剖面光学', async () => {
    const renderer = createRenderer()
    wrapper = mountTuner(renderer)
    await wrapper.get('.tuner-launcher').trigger('click')
    const checkbox = wrapper.get('[data-section="renderer"] input[data-field="optics"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    await checkbox.setValue(false)
    expect(renderer.setOptics).toHaveBeenCalledWith('raymarch')
    expect(renderer.optics.value).toBe('raymarch')
  })

  it('没有渲染控制器时只显示玻璃参数', async () => {
    wrapper = mountTuner(null)
    await wrapper.get('.tuner-launcher').trigger('click')
    expect(wrapper.find('[data-section="renderer"]').exists()).toBe(false)
    expect(wrapper.find('[data-section="material"]').exists()).toBe(true)
  })
})

describe('入口位置', () => {
  beforeEach(() => {
    wrapper = mountTuner()
  })

  it('拖出视口时按钮被限制在边缘内', () => {
    expect(clampLauncherPosition({ x: -200, y: 900 }, { x: 390, y: 844 }, 56)).toEqual({ x: 12, y: 776 })
  })

  it('按钮在顶部时面板向下展开', () => {
    expect(tunerPanelPosition({ x: 12, y: 12 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)).toEqual({ x: 12, y: 80 })
  })

  it('按钮在底部时面板向上展开', () => {
    const result = tunerPanelPosition({ x: 310, y: 760 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)
    expect(result).toEqual({ x: 12, y: 268 })
  })
})
