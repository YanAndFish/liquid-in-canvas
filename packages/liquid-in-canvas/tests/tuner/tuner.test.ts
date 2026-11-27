import type { LiquidGlassMount } from '../../src/mount'
import type { GlassTuner, GlassTunerOptions } from '../../src/tuner/GlassTuner'
import type { GlassTunerRenderer } from '../../src/tuner/renderer'
import type { GlassOptics, StageResolution } from '../../src/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlassDefaults, resetGlassDefaults } from '../../src/liquid-glass/defaults'
import { DEFAULT_STAGE_RESOLUTION } from '../../src/resolution'
import { createGlassTuner } from '../../src/tuner/GlassTuner'
import { clampLauncherPosition, tunerPanelPosition } from '../../src/tuner/position'
import { rendererFromMount } from '../../src/tuner/renderer'
import { TUNER_STYLE_ID } from '../../src/tuner/styles'

type FakeRenderer = GlassTunerRenderer & {
  mode: GlassTunerRenderer['mode']
  optics: GlassOptics
  resolution: StageResolution
  setMode: ReturnType<typeof vi.fn>
  setResolution: ReturnType<typeof vi.fn>
  setOptics: ReturnType<typeof vi.fn>
}

function createRenderer(canvasSupported = true, svgSupported = true, dpr = 2): FakeRenderer {
  const renderer: FakeRenderer = {
    mode: canvasSupported
      ? 'canvas'
      : svgSupported ? 'svg' : 'css',
    canvasSupported,
    svgSupported,
    resolution: { ...DEFAULT_STAGE_RESOLUTION },
    optics: 'profile',
    metrics: () => ({
      cssWidth: 1000,
      cssHeight: 800,
      pixelWidth: 2000,
      pixelHeight: 1600,
      dpr,
      targetDpr: 2,
      glassDpr: 1.5,
      optics: 'profile',
    }),
    setMode: vi.fn(async (next) => {
      renderer.mode = next
    }),
    setResolution: vi.fn((patch) => {
      renderer.resolution = {
        ...renderer.resolution,
        ...patch,
      }
    }),
    setOptics: vi.fn((next) => {
      renderer.optics = next
    }),
  }
  return renderer
}

let tuner: GlassTuner

function create(options: GlassTunerOptions = {}): GlassTuner {
  tuner = createGlassTuner({
    locale: 'zh',
    theme: 'dark',
    renderer: createRenderer(),
    ...options,
  })
  return tuner
}

function $<E extends Element = HTMLElement>(selector: string): E {
  const element = tuner.element.querySelector<E>(selector)
  if (!element)
    throw new Error(`Missing ${selector}`)
  return element
}

function launcher(): HTMLButtonElement {
  return $('.lg-tuner-launcher')
}

function click(element: Element, detail = 1): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
}

function setValue(input: HTMLInputElement, value: string | boolean): void {
  if (typeof value === 'boolean') {
    input.checked = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  else {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function isHidden(element: Element): boolean {
  return element.closest('[hidden]') !== null
}

afterEach(() => {
  tuner?.destroy()
  resetGlassDefaults()
})

describe('调参面板', () => {
  beforeEach(() => {
    create()
  })

  it('插入页面与样式表，销毁后一并移除', () => {
    expect(tuner.element.isConnected).toBe(true)
    expect(document.getElementById(TUNER_STYLE_ID)).not.toBeNull()
    tuner.destroy()
    expect(tuner.element.isConnected).toBe(false)
    expect(document.getElementById(TUNER_STYLE_ID)).toBeNull()
  })

  it('点击打开面板后 Escape 关闭并恢复入口焦点', () => {
    click(launcher())
    expect(tuner.opened).toBe(true)
    expect(launcher().getAttribute('aria-expanded')).toBe('true')
    $('input[data-field="blur"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(tuner.element.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(launcher())
  })

  it('面板从入口分出、关闭时流回入口，展开时入口移到面板所在的层', () => {
    expect(launcher().dataset.glassLayer).toBe('0')
    tuner.open()
    const panel = $('[role="dialog"]')
    expect(panel.dataset.glassMorphFrom).toBe(launcher().dataset.glassMorph)
    expect(panel.dataset.glassMorph).not.toBe(launcher().dataset.glassMorph)
    expect(panel.dataset.glassLayer).toBe('1')
    expect(launcher().dataset.glassLayer).toBe('1')
  })

  it('拖动滑块修改当前主题下所选材质的全局默认值', () => {
    tuner.open()
    setValue($('input[data-field="blur"]'), '40')
    expect(getGlassDefaults().materials.regular.dark.blur).toBe(40)
    expect(getGlassDefaults().materials.regular.light.blur).toBe(14)
    expect(getGlassDefaults().materials.clear.dark.blur).toBe(0)
    expect($('input[data-field="blur"]').closest('label')!.querySelector('output')!.textContent).toBe('40px')

    click($('button[data-variant="clear"]'))
    setValue($('input[data-field="dispersion"]'), '0.8')
    expect(getGlassDefaults().materials.clear.dark.dispersion).toBe(0.8)
    expect(getGlassDefaults().materials.regular.dark.dispersion).toBe(0.14)
  })

  it('形体参数与染色写入全局默认值', () => {
    tuner.open()
    setValue($('input[data-field="fusion"]'), '64')
    setValue($('input[data-field="tint"]'), '#336699')
    expect(getGlassDefaults().fusion).toBe(64)
    expect(getGlassDefaults().materials.regular.dark.tint).toBe('#336699')
  })

  it('外部修改默认参数后面板同步显示', async () => {
    tuner.open()
    const { setGlassDefaults } = await import('../../src/liquid-glass/defaults')
    setGlassDefaults({ elevation: 30 })
    expect($<HTMLInputElement>('input[data-field="elevation"]').value).toBe('30')
    expect($('.lg-tuner-profile').textContent).toContain('悬浮 30px')
  })

  it('恢复默认会还原玻璃参数', () => {
    tuner.open()
    setValue($('input[data-field="blur"]'), '40')
    click($('button[data-action="reset"]'))
    expect(getGlassDefaults().materials.regular.dark.blur).toBe(14)
    expect($<HTMLInputElement>('input[data-field="blur"]').value).toBe('14')
  })

  it('拖动后产生的点击不会打开面板', () => {
    const button = launcher()
    Object.assign(button, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    })
    button.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 900,
      clientY: 600,
    }))
    button.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 700, clientY: 400 }))
    button.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 700, clientY: 400 }))
    click(button)
    expect(tuner.opened).toBe(false)
    expect(button.style.left).toBe('732px')
  })

  it('方向键移动入口', () => {
    const before = Number.parseFloat(launcher().style.left)
    launcher().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(Number.parseFloat(launcher().style.left)).toBe(before - 16)
  })

  it('隐藏时收起面板', () => {
    tuner.open()
    tuner.setHidden(true)
    expect(tuner.opened).toBe(false)
    expect(tuner.element.hasAttribute('data-hidden')).toBe(true)
    tuner.open()
    expect(tuner.opened).toBe(false)
    tuner.setHidden(false)
    expect(tuner.element.hasAttribute('data-hidden')).toBe(false)
  })

  it('切换语言后文案随之改变', () => {
    tuner.open()
    expect($('h2').textContent).toBe('玻璃调参')
    tuner.setLocale('en')
    expect($('h2').textContent).toBe('Glass tuning')
    expect($('.lg-tuner-close').getAttribute('aria-label')).toBe('Close tuning panel')
    expect($('.lg-tuner-profile').textContent).toContain('Thickness')
  })

  it('跟随页面主题，切换后改为调整另一主题的材质', async () => {
    tuner.destroy()
    create({ theme: undefined })
    document.documentElement.dataset.theme = 'light'
    tuner.update()
    tuner.open()
    expect(tuner.element.dataset.theme).toBe('light')
    setValue($('input[data-field="blur"]'), '30')
    expect(getGlassDefaults().materials.regular.light.blur).toBe(30)
    document.documentElement.dataset.theme = 'dark'
    await Promise.resolve()
    expect(tuner.element.dataset.theme).toBe('dark')
    expect($('[data-section="material"] h3').textContent).toContain('深色主题')
    delete document.documentElement.dataset.theme
  })
})

describe('渲染方式开关', () => {
  it('完整支持的浏览器可以在画布与两种回退之间切换', async () => {
    const renderer = createRenderer()
    create({ renderer })
    tuner.open()
    expect($('button[data-mode="canvas"]').getAttribute('aria-pressed')).toBe('true')
    click($('button[data-mode="css"]'))
    expect(renderer.setMode).toHaveBeenCalledWith('css')
    await Promise.resolve()
    expect($('button[data-mode="css"]').getAttribute('aria-pressed')).toBe('true')
    expect(isHidden($('input[data-field="adaptive"]'))).toBe(true)
    click($('button[data-mode="svg"]'))
    expect(renderer.setMode).toHaveBeenCalledWith('svg')
    await Promise.resolve()
    const svgHint = [
      ...tuner.element.querySelectorAll('.lg-tuner-hint'),
    ].find(hint => hint.textContent!.includes('SVG 滤镜回退'))!
    expect(isHidden(svgHint)).toBe(false)
  })

  it('渲染器没有实现切换时禁用所有渲染方式按钮', () => {
    const renderer = createRenderer()
    create({
      renderer: { ...renderer, setMode: undefined, resolution: renderer.resolution },
    })
    tuner.open()
    const buttons = [
      ...tuner.element.querySelectorAll<HTMLButtonElement>('button[data-mode]'),
    ]
    expect(buttons.every(button => button.disabled)).toBe(true)
    expect($('button[data-mode="canvas"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('不能把 SVG 滤镜用作背景滤镜的浏览器禁用该选项', () => {
    create({
      renderer: createRenderer(false, false),
    })
    tuner.open()
    expect($<HTMLButtonElement>('button[data-mode="svg"]').disabled).toBe(true)
    expect($('button[data-mode="css"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('显示画布与玻璃着色的实际倍率', () => {
    create()
    tuner.open()
    expect($('[data-role="ratios"]').textContent).toContain('2.00×')
    expect($('[data-role="ratios"]').textContent).toContain('1.50×')
  })

  it('面板打开期间定时刷新实际倍率', () => {
    vi.useFakeTimers()
    try {
      let dpr = 2
      const renderer = createRenderer()
      renderer.metrics = () => ({
        ...createRenderer().metrics()!,
        dpr,
      })
      create({ renderer })
      tuner.open()
      dpr = 1.25
      vi.advanceTimersByTime(500)
      expect($('[data-role="ratios"]').textContent).toContain('1.25×')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('自适应降低画布倍率时在倍率旁说明原来的倍率', () => {
    create()
    tuner.open()
    expect($('[data-role="ratios"]').textContent).not.toContain('已自动降低')
    tuner.destroy()
    create({
      renderer: createRenderer(true, true, 1.5),
    })
    tuner.open()
    const text = $('[data-role="ratios"]').textContent
    expect(text).toContain('1.50×')
    expect(text).toContain('已自动降低')
    expect(text).toContain('2.00×')
  })

  it('自适应降级缺省不降低画布倍率，可以显式允许', () => {
    const renderer = createRenderer()
    create({ renderer })
    tuner.open()
    const box = $<HTMLInputElement>('[data-field="adaptiveCanvas"]')
    expect(box.checked).toBe(false)
    setValue(box, true)
    expect(renderer.setResolution).toHaveBeenCalledWith({ minPixelRatio: 1 })
    expect(box.checked).toBe(true)
    setValue(box, false)
    expect(renderer.setResolution).toHaveBeenCalledWith({ minPixelRatio: Infinity })
    expect(box.checked).toBe(false)
  })

  it('不支持画布的浏览器禁用画布选项', () => {
    create({
      renderer: createRenderer(false),
    })
    tuner.open()
    expect($<HTMLButtonElement>('button[data-mode="canvas"]').disabled).toBe(true)
    const hint = [
      ...tuner.element.querySelectorAll('.lg-tuner-hint'),
    ].find(hint => hint.textContent!.includes('不能使用画布渲染'))!
    expect(isHidden(hint)).toBe(false)
  })

  it('调整渲染倍率上限', () => {
    const renderer = createRenderer()
    create({ renderer })
    tuner.open()
    setValue($('[data-section="renderer"] input[type="range"]'), '1.5')
    expect(renderer.setResolution).toHaveBeenCalledWith({ maxPixelRatio: 1.5 })
    expect($('[data-section="renderer"] output').textContent).toBe('1.50×')
  })

  it('在剖面、混合与三维求交之间切换光路', () => {
    const renderer = createRenderer()
    create({ renderer })
    tuner.open()
    const pressed = () => [
      ...tuner.element.querySelectorAll('[data-field="optics"] button'),
    ]
      .filter(button => button.getAttribute('aria-pressed') === 'true')
      .map(button => button.getAttribute('data-optics'))
    expect(pressed()).toEqual(['profile'])
    click($('[data-optics="hybrid"]'))
    expect(renderer.setOptics).toHaveBeenCalledWith('hybrid')
    expect(pressed()).toEqual(['hybrid'])
    expect($('[data-role="optics"]').textContent).toContain('混合光路')
    click($('[data-optics="raymarch"]'))
    expect(renderer.optics).toBe('raymarch')
  })

  it('自适应把光路降为剖面时在倍率旁说明', () => {
    create()
    tuner.open()
    expect($('[data-role="ratios"]').textContent).not.toContain('光路已自动降为剖面')
    click($('[data-optics="hybrid"]'))
    expect($('[data-role="ratios"]').textContent).toContain('光路已自动降为剖面')
  })

  it('没有渲染器时只显示玻璃参数', () => {
    create({ renderer: null })
    tuner.open()
    expect(isHidden($('[data-section="renderer"]'))).toBe(true)
    expect(isHidden($('[data-section="material"]'))).toBe(false)
  })

  it('替换渲染器后显示渲染方式一节', () => {
    create({ renderer: null })
    tuner.open()
    tuner.setRenderer(createRenderer())
    expect(isHidden($('[data-section="renderer"]'))).toBe(false)
  })
})

describe('从挂载创建', () => {
  function fakeMount(root: HTMLElement): LiquidGlassMount {
    let resolution = { ...DEFAULT_STAGE_RESOLUTION, maxPixelRatio: 2 }
    const stage = {
      getResolution: () => ({ ...resolution }),
      setResolution: vi.fn((patch: Partial<StageResolution>) => {
        resolution = {
          ...resolution,
          ...patch,
        }
      }),
      getOptics: () => 'hybrid' as GlassOptics,
      setOptics: vi.fn(),
      getMetrics: () => ({
        cssWidth: 1,
        cssHeight: 1,
        pixelWidth: 1,
        pixelHeight: 1,
        dpr: 2,
        targetDpr: 2,
        glassDpr: 2,
        optics: 'hybrid' as GlassOptics,
      }),
    }
    return {
      root,
      mode: 'canvas',
      stage: stage as unknown as LiquidGlassMount['stage'],
      canvas: null,
      support: { supported: true, missing: [], capabilities: {} } as unknown as LiquidGlassMount['support'],
      setTheme: vi.fn(),
      addGlass: vi.fn(),
      removeGlass: vi.fn(),
      dispose: vi.fn(),
    }
  }

  it('插入挂载的根元素，并读写舞台的分辨率与光路', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const mount = fakeMount(root)
    tuner = createGlassTuner({ mount, locale: 'zh', theme: 'dark' })
    expect(tuner.element.parentElement).toBe(root)
    tuner.open()
    expect($<HTMLInputElement>('input[data-field="maxPixelRatio"]').value).toBe('2')
    expect($('[data-optics="hybrid"]').getAttribute('aria-pressed')).toBe('true')
    setValue($('input[data-field="maxPixelRatio"]'), '1.5')
    expect(mount.stage!.setResolution).toHaveBeenCalledWith({ maxPixelRatio: 1.5 })
    tuner.destroy()
    root.remove()
  })

  it('传入函数时跟随新的挂载', () => {
    const root = document.createElement('div')
    let mount: LiquidGlassMount = fakeMount(root)
    const renderer = rendererFromMount(() => mount, {
      setMode: vi.fn(),
    })
    expect(renderer.mode).toBe('canvas')
    mount = {
      ...fakeMount(root),
      mode: 'svg',
      stage: null,
    }
    expect(renderer.mode).toBe('svg')
    expect(renderer.metrics()).toBeNull()
    renderer.setResolution({ maxGlassPixelRatio: 1 })
    expect(renderer.resolution.maxGlassPixelRatio).toBe(1)
  })
})

describe('入口位置', () => {
  it('拖出视口时按钮被限制在边缘内', () => {
    expect(clampLauncherPosition({ x: -200, y: 900 }, { x: 390, y: 844 }, 56)).toEqual({ x: 12, y: 776 })
  })

  it('按钮在顶部时面板向下展开', () => {
    expect(tunerPanelPosition({ x: 12, y: 12 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)).toEqual({ x: 12, y: 80 })
  })

  it('按钮在底部时面板向上展开', () => {
    expect(tunerPanelPosition({ x: 310, y: 760 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)).toEqual({ x: 12, y: 268 })
  })
})
