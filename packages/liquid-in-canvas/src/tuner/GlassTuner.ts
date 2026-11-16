import type { GlassDefaults, GlassMaterial, GlassTheme, GlassVariant } from '../liquid-glass/defaults'
import type { GlassRenderMode, LiquidGlassMount } from '../mount'
import type { GlassOptics, StageResolution } from '../types'
import type { Field, GlassTunerLocale, MaterialNumber, MorphNumber, ShapeNumber, Text } from './messages'
import type { TunerPoint } from './position'
import type { GlassTunerRenderer } from './renderer'
import { getGlassDefaults, GLASS_LIMITS, onGlassDefaultsChange, resetGlassDefaults, setGlassDefaults } from '../liquid-glass/defaults'
import { GlassThemeSource } from '../liquid-glass/theme'
import { DEFAULT_STAGE_RESOLUTION } from '../resolution'
import { prefersReducedMotion } from '../shared/motion'
import { detectLocale, MATERIAL_FIELDS, MODES, MORPH_FIELDS, OPTICS, PROFILE_FIELDS, SHAPE_FIELDS, TEXT, VARIANTS } from './messages'
import { clampLauncherPosition, tunerPanelPosition } from './position'
import { renderProfileDiagram } from './profile-diagram'
import { rendererFromMount } from './renderer'
import { retainTunerStyle } from './styles'

export interface GlassTunerOptions {
  /**
   * 面板插入到哪个元素末尾。画布模式下必须位于 `mountLiquidGlass()` 的根元素之内，玻璃才会被画出来。
   * 缺省为 `mount.root`，没有 `mount` 时为 `document.body`。
   */
  container?: HTMLElement
  /** 由这个挂载提供渲染方式一节（分辨率、光路、实际倍率），见 `rendererFromMount()`。 */
  mount?: LiquidGlassMount | null
  /** 自定义渲染方式一节，优先于 `mount`；需要在面板里切换渲染方式时实现 `setMode`。 */
  renderer?: GlassTunerRenderer | null
  /** 文案语言，缺省按 `<html lang>` 再按浏览器语言选择。 */
  locale?: GlassTunerLocale
  /** 固定调整哪个主题的材质并使用对应配色，缺省与舞台一样跟随 `<html data-theme>` 和系统配色。 */
  theme?: GlassTheme | null
  /**
   * 面板展开时所在的玻璃层，缺省为 1。同层玻璃会相互融合：面板很大，如果留在页面玻璃所在的层，
   * 滚到它下面的每个控件都会并入同一个融合组，整块面板逐像素求交，帧率明显下降。
   * 单独一层后只与入口按钮融合；收起时入口按钮回到第 0 层，拖到其他玻璃旁边仍然可以观察融合。
   */
  layer?: number
  /** 面板根元素的 `z-index`，缺省为 1000。 */
  zIndex?: number
  /** 入口按钮左上角的初始位置（视口坐标），缺省在右下角。 */
  position?: TunerPoint
  /** 初始时隐藏入口，见 `GlassTuner.setHidden()`。 */
  hidden?: boolean
  /** 创建后立即展开面板。 */
  open?: boolean
}

/** `createGlassTuner()` 的返回值。 */
export interface GlassTuner {
  /** 面板的根元素。 */
  readonly element: HTMLElement
  /** 面板是否展开。 */
  readonly opened: boolean
  open: () => void
  /** 收起面板；`restoreFocus` 缺省为 true，把焦点交回入口按钮。 */
  close: (restoreFocus?: boolean) => void
  toggle: () => void
  /** 隐藏或显示入口，隐藏时同时收起面板。适合在模态界面打开期间调用。 */
  setHidden: (hidden: boolean) => void
  setLocale: (locale: GlassTunerLocale) => void
  /** 固定主题，传入 null 恢复跟随页面。 */
  setTheme: (theme: GlassTheme | null) => void
  /** 替换渲染方式一节的数据来源，传入 null 隐藏这一节。 */
  setRenderer: (renderer: GlassTunerRenderer | null) => void
  /** 重新读取渲染器状态并刷新面板。渲染器在面板之外变化时调用。 */
  update: () => void
  /** 移除面板与它注册的监听。 */
  destroy: () => void
}

/** 一个滑块：从哪里读值、写到哪里，以及上次写入输入框的值。 */
interface Slider {
  input: HTMLInputElement
  output: HTMLOutputElement
  format: (value: number) => string
  read: () => number
  last: number
}

interface RendererSection {
  section: HTMLElement
  modes: [GlassRenderMode, HTMLButtonElement][]
  error: HTMLElement
  errorText: HTMLElement
  svgHint: HTMLElement
  cssHint: HTMLElement
  unsupported: HTMLElement
  canvas: HTMLElement
  adaptive: HTMLInputElement
  adaptiveCanvas: HTMLInputElement
  optics: [GlassOptics, HTMLButtonElement][]
  opticsHint: HTMLElement
  ratios: HTMLElement
}

interface Panel {
  anchor: HTMLDivElement
  glass: HTMLElement
  sliders: Slider[]
  variants: [GlassVariant, HTMLButtonElement][]
  materialTitle: HTMLElement
  profileTitle: HTMLElement
  tint: HTMLInputElement
  tintOutput: HTMLOutputElement
  diagram: HTMLElement
  diagramKey: string
  renderer: RendererSection
  copy: HTMLButtonElement
}

type Props = Record<string, string | number | boolean | undefined>

const ICONS = {
  adjust: 'M4 7h8M16 7h4M4 17h3M11 17h9M12 4v6M7 14v6',
  close: 'M6 6l12 12M18 6 6 18',
}

let instances = 0

function icon(name: keyof typeof ICONS, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: readonly (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false)
      continue
    element.setAttribute(name, value === true
      ? ''
      : String(value))
  }
  element.append(...children)
  return element
}

function setText(element: Element, value: string): void {
  if (element.textContent !== value)
    element.textContent = value
}

function setAttr(element: Element, name: string, value: string | null): void {
  if (value === null) {
    if (element.hasAttribute(name))
      element.removeAttribute(name)
  }
  else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value)
  }
}

function setStyle(element: HTMLElement, name: string, value: string): void {
  if (element.style.getPropertyValue(name) !== value)
    element.style.setProperty(name, value)
}

function show(element: HTMLElement, visible: boolean): void {
  if (element.hidden === visible)
    element.hidden = !visible
}

function setDisabled(element: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  if (element.disabled !== disabled)
    element.disabled = disabled
}

function setChecked(element: HTMLInputElement, checked: boolean): void {
  if (element.checked !== checked)
    element.checked = checked
}

/** 小数步长保留两位，整数步长不带小数。 */
function formatField(value: number, field: Field<string>): string {
  return `${field.step < 1
    ? value.toFixed(2)
    : Math.round(value)}${field.unit ?? ''}`
}

class GlassTunerView implements GlassTuner {
  readonly element: HTMLDivElement
  private readonly launcher: HTMLButtonElement
  private readonly id: string
  private readonly layer: number
  private readonly theme: GlassThemeSource
  private readonly releaseStyle: () => void
  private readonly unsubscribe: () => void
  /** 需要随语言切换的文案：写入文字，或写入第三项指定的属性。 */
  private labels: [Element, Text, string?][] = []
  private renderer: GlassTunerRenderer | null
  private locale: GlassTunerLocale
  private panel: Panel | null = null
  /** 回退实现下正在播放收起动画、尚未移除的面板。 */
  private leaving: HTMLElement | null = null
  private variant: GlassVariant = 'regular'
  private hidden: boolean
  private dragging = false
  private copied = false
  private suppressClick = false
  private gesture: { pointerId: number, startX: number, startY: number, left: number, top: number } | null = null
  private viewport: TunerPoint
  private position: TunerPoint
  private launcherIcon = ''
  private copyTimer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private destroyed = false

  constructor(options: GlassTunerOptions) {
    this.id = `lg-tuner-${++instances}`
    this.layer = options.layer ?? 1
    this.locale = options.locale ?? detectLocale()
    this.renderer = options.renderer ?? (options.mount
      ? rendererFromMount(options.mount)
      : null)
    this.hidden = options.hidden ?? false
    this.viewport = { x: window.innerWidth, y: window.innerHeight }
    this.position = options.position ?? { x: this.viewport.x - 92, y: this.viewport.y - 92 }
    this.releaseStyle = retainTunerStyle()
    this.theme = new GlassThemeSource(() => this.update(), options.theme ?? null)

    this.launcher = h('button', {
      'type': 'button',
      'class': 'lg-tuner-launcher',
      'data-liquid-glass': true,
      'data-glass-radius': 999,
      'data-glass-fusion': 40,
      'data-glass-variant': 'clear',
      'data-glass-morph': 'lg-tuner',
    })
    this.element = h('div', { class: 'lg-tuner' }, [this.launcher])
    this.element.style.zIndex = String(options.zIndex ?? 1000)

    this.element.addEventListener('keydown', this.onKeydown)
    this.launcher.addEventListener('pointerdown', this.startDrag)
    this.launcher.addEventListener('pointermove', this.moveDrag)
    this.launcher.addEventListener('pointerup', this.endDrag)
    this.launcher.addEventListener('pointercancel', this.endDrag)
    this.launcher.addEventListener('lostpointercapture', this.endDrag)
    this.launcher.addEventListener('keydown', this.moveWithKeyboard)
    this.launcher.addEventListener('click', this.onLauncherClick)
    window.addEventListener('resize', this.onResize, { passive: true })
    this.unsubscribe = onGlassDefaultsChange(() => this.update())
    this.theme.start()

    const container = options.container ?? options.mount?.root ?? document.body
    container.append(this.element)
    this.onResize()
    if (options.open && !this.hidden)
      this.open()
  }

  get opened(): boolean {
    return this.panel !== null
  }

  open(): void {
    if (this.panel || this.hidden || this.destroyed)
      return
    this.leaving?.remove()
    this.leaving = null
    const panel = this.buildPanel()
    this.panel = panel
    this.element.insertBefore(panel.anchor, this.launcher)
    this.update()
    // 画布渲染下，面板的玻璃从同名 `data-glass-morph` 的入口里流出来、长成面板；
    // 回退实现没有液体流动，用缩放过渡，从按钮所在的方向展开。
    if (this.animated()) {
      panel.anchor.animate([
        { opacity: 0 },
        { opacity: 1 },
      ], { duration: 160, easing: 'ease' })
      panel.anchor.animate([
        { transform: 'scale(.2)' },
        { transform: 'none' },
      ], { duration: 320, easing: 'cubic-bezier(.3, 1.3, .5, 1)' })
    }
    clearInterval(this.pollTimer)
    // 面板打开期间定时读取实际倍率与光路，自适应降级后能及时显示。
    this.pollTimer = setInterval(() => this.update(), 500)
  }

  close(restoreFocus = true): void {
    const panel = this.panel
    if (panel) {
      this.panel = null
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
      const anchor = panel.anchor
      if (this.animated()) {
        this.leaving = anchor
        anchor.style.pointerEvents = 'none'
        anchor.animate([
          { opacity: 1 },
          { opacity: 0 },
        ], { duration: 140, easing: 'ease', fill: 'forwards' })
        const animation = anchor.animate([
          { transform: 'none' },
          { transform: 'scale(.2)' },
        ], { duration: 180, easing: 'ease-in', fill: 'forwards' })
        animation.finished.then(() => {
          anchor.remove()
          if (this.leaving === anchor)
            this.leaving = null
        }, () => {})
      }
      else {
        anchor.remove()
      }
      this.update()
    }
    if (restoreFocus)
      this.launcher.focus({ preventScroll: true })
  }

  toggle(): void {
    if (this.panel)
      this.close()
    else
      this.open()
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden)
      return
    this.hidden = hidden
    if (hidden)
      this.close(false)
    this.update()
  }

  setLocale(locale: GlassTunerLocale): void {
    this.locale = locale
    this.update()
  }

  setTheme(theme: GlassTheme | null): void {
    this.theme.set(theme)
  }

  setRenderer(renderer: GlassTunerRenderer | null): void {
    this.renderer = renderer
    this.update()
  }

  destroy(): void {
    if (this.destroyed)
      return
    this.destroyed = true
    clearTimeout(this.copyTimer)
    clearInterval(this.pollTimer)
    this.theme.stop()
    this.unsubscribe()
    window.removeEventListener('resize', this.onResize)
    this.element.remove()
    this.panel = null
    this.leaving = null
    this.labels = []
    this.releaseStyle()
  }

  /** 把当前状态写入 DOM。只写入有变化的属性和文字：画布模式下每次改动都会让舞台重建内容快照。 */
  update(): void {
    if (this.destroyed)
      return
    const defaults = getGlassDefaults()
    const theme = this.theme.value
    const opened = this.panel !== null
    const buttonSize = this.buttonSize()
    setAttr(this.element, 'data-theme', theme)
    setAttr(this.element, 'data-hidden', this.hidden ? '' : null)

    const launcher = this.launcher
    setStyle(launcher, 'left', `${this.position.x}px`)
    setStyle(launcher, 'top', `${this.position.y}px`)
    setStyle(launcher, 'width', `${buttonSize}px`)
    setStyle(launcher, 'height', `${buttonSize}px`)
    setAttr(launcher, 'data-glass-layer', String(opened ? this.layer : 0))
    setAttr(launcher, 'aria-label', this.tr(TEXT.title))
    setAttr(launcher, 'aria-expanded', String(opened))
    setAttr(launcher, 'title', this.tr(TEXT.launcherTitle))
    launcher.classList.toggle('is-dragging', this.dragging)
    const iconName = opened ? 'close' : 'adjust'
    if (this.launcherIcon !== iconName) {
      this.launcherIcon = iconName
      launcher.innerHTML = icon(iconName, 25)
    }

    const panel = this.panel
    if (!panel)
      return
    this.layoutPanel(panel, buttonSize)
    setAttr(panel.glass, 'data-glass-tint', theme === 'dark'
      ? '#10191a'
      : '#f5f5ef')
    setAttr(panel.glass, 'data-glass-tint-alpha', theme === 'dark'
      ? '0.68'
      : '0.66')
    for (const [element, text, attribute] of this.labels) {
      if (attribute)
        setAttr(element, attribute, this.tr(text))
      else
        setText(element, this.tr(text))
    }

    const material = this.material(defaults, theme)
    const variant = VARIANTS.find(option => option.id === this.variant) ?? VARIANTS[0]!
    setText(panel.materialTitle, `${this.tr(TEXT.material)} · ${this.tr(theme === 'dark'
      ? TEXT.darkTheme
      : TEXT.lightTheme)}`)
    setText(panel.profileTitle, `${this.tr(TEXT.profile)} · ${this.tr(variant.label)}`)
    for (const [id, button] of panel.variants)
      setAttr(button, 'aria-pressed', String(id === this.variant))
    for (const slider of panel.sliders)
      this.syncSlider(slider)
    setText(panel.tintOutput, material.tint)
    if (panel.tint.value !== material.tint)
      panel.tint.value = material.tint

    const diagramKey = `${this.locale}|${defaults.elevation}|${material.refraction}|${material.bevelWidth}|${material.bevelHeight}|${material.bevelCurve}|${material.bottomBevel}`
    if (panel.diagramKey !== diagramKey) {
      panel.diagramKey = diagramKey
      panel.diagram.innerHTML = renderProfileDiagram(material, defaults.elevation, this.locale, `${this.id}-profile`)
    }

    this.syncRenderer(panel.renderer)
    setText(panel.copy, this.tr(this.copied ? TEXT.copied : TEXT.copy))
  }

  private tr(text: Text): string {
    return this.locale === 'zh'
      ? text[0]
      : text[1]
  }

  /** 画布模式下面板在画布里，玻璃自己有液体流动，不用 CSS 动画。 */
  private animated(): boolean {
    return !this.element.closest('canvas') && typeof this.element.animate === 'function' && !prefersReducedMotion()
  }

  private buttonSize(): number {
    return this.viewport.x < 600
      ? 56
      : 64
  }

  private material(defaults: GlassDefaults, theme: GlassTheme): GlassMaterial {
    return defaults.materials[this.variant][theme]
  }

  /**
   * 面板一步出现在最终位置与尺寸。逐帧改变面板的位置和尺寸会让画布每帧重建内容快照，文字与控件随之闪烁。
   */
  private layoutPanel(panel: Panel, buttonSize: number): void {
    const size = {
      x: Math.min(360, this.viewport.x - 24),
      y: Math.min(620, this.viewport.y - buttonSize - 48),
    }
    const at = tunerPanelPosition(this.position, this.viewport, size, buttonSize)
    const anchor = panel.anchor
    setStyle(anchor, 'left', `${at.x}px`)
    setStyle(anchor, 'top', `${at.y}px`)
    setStyle(anchor, 'width', `${size.x}px`)
    setStyle(anchor, 'height', `${size.y}px`)
    setStyle(anchor, 'transform-origin', `${this.position.x + buttonSize / 2 - at.x}px ${this.position.y + buttonSize / 2 - at.y}px`)
  }

  private syncSlider(slider: Slider): void {
    const value = slider.read()
    setText(slider.output, slider.format(value))
    if (slider.last !== value) {
      slider.last = value
      slider.input.value = String(value)
    }
  }

  private syncRenderer(refs: RendererSection): void {
    const renderer = this.renderer
    show(refs.section, renderer !== null)
    if (!renderer)
      return
    const mode = renderer.mode
    const canvas = mode === 'canvas'
    for (const [id, button] of refs.modes) {
      setAttr(button, 'aria-pressed', String(mode === id))
      setDisabled(button, !renderer.setMode || !!renderer.switching
      || (id === 'canvas' && !renderer.canvasSupported)
      || (id === 'svg' && !renderer.svgSupported))
    }
    const error = renderer.error ?? ''
    show(refs.error, error !== '')
    setText(refs.errorText, error)
    show(refs.svgHint, !error && mode === 'svg')
    show(refs.cssHint, !error && mode === 'css')
    show(refs.unsupported, !renderer.canvasSupported)
    show(refs.canvas, canvas)
    if (!canvas)
      return

    const resolution = renderer.resolution
    const optics = renderer.optics
    setChecked(refs.adaptive, resolution.adaptive)
    setDisabled(refs.adaptiveCanvas, !resolution.adaptive)
    setChecked(refs.adaptiveCanvas, resolution.minPixelRatio < resolution.maxPixelRatio)
    for (const [id, button] of refs.optics)
      setAttr(button, 'aria-pressed', String(optics === id))
    const hint = OPTICS.find(option => option.id === optics) ?? OPTICS[0]!
    setText(refs.opticsHint, this.tr(hint.hint))

    const metrics = renderer.metrics()
    show(refs.ratios, metrics !== null)
    if (!metrics)
      return
    let text = `${this.tr(TEXT.canvasNow)} ${metrics.dpr.toFixed(2)}×`
    if (metrics.dpr < metrics.targetDpr - 0.005)
      text += ` ${this.tr(TEXT.loweredFrom)} ${metrics.targetDpr.toFixed(2)}×${this.tr(TEXT.loweredEnd)}`
    text += ` · ${this.tr(TEXT.glassShading)} ${metrics.glassDpr.toFixed(2)}×`
    if (metrics.optics !== optics)
      text += ` · ${this.tr(TEXT.opticsLowered)}`
    setText(refs.ratios, text)
  }

  /** 创建一段随语言切换的文字。 */
  private label<K extends keyof HTMLElementTagNameMap>(tag: K, text: Text, props: Props = {}): HTMLElementTagNameMap[K] {
    const element = h(tag, props)
    this.labels.push([element, text])
    return element
  }

  private slider(sliders: Slider[], key: string, text: Text, props: Props, format: (value: number) => string, read: () => number, write: (value: number) => void): HTMLLabelElement {
    const output = h('output')
    const input = h('input', { 'type': 'range', 'data-field': key, ...props })
    input.addEventListener('input', () => write(Number(input.value)))
    sliders.push({
      input,
      output,
      format,
      read,
      last: Number.NaN,
    })
    return h('label', { class: 'lg-tuner-field' }, [
      this.label('span', text),
      output,
      input,
    ])
  }

  private glassSlider(sliders: Slider[], field: Field<MaterialNumber | ShapeNumber | MorphNumber>, read: () => number, write: (value: number) => void): HTMLLabelElement {
    const [min, max] = GLASS_LIMITS[field.key]
    return this.slider(sliders, field.key, field.label, { min, max: field.max ?? max, step: field.step }, value => formatField(value, field), read, write)
  }

  private segment<Id extends string>(name: string, aria: Text, options: readonly { id: Id, label: Text }[], props: Props, onSelect: (id: Id) => void): [HTMLDivElement, [Id, HTMLButtonElement][]] {
    const buttons: [Id, HTMLButtonElement][] = options.map((option) => {
      const button = this.label('button', option.label, { type: 'button', [`data-${name}`]: option.id })
      button.addEventListener('click', () => onSelect(option.id))
      return [option.id, button]
    })
    const group = h('div', { class: 'lg-tuner-segment', role: 'group', ...props }, buttons.map(([, button]) => button))
    this.labels.push([group, aria, 'aria-label'])
    return [group, buttons]
  }

  private hint(text: Text | null, props: Props = {}): HTMLParagraphElement {
    return text
      ? this.label('p', text, { class: 'lg-tuner-hint', ...props })
      : h('p', { class: 'lg-tuner-hint', ...props })
  }

  private section(name: string, children: (Node | string)[]): HTMLElement {
    return h('section', { 'class': 'lg-tuner-section', 'data-section': name }, children)
  }

  private buildPanel(): Panel {
    // 文案随面板重建，上一次的不再需要。
    this.labels = []
    const sliders: Slider[] = []
    const readMaterial = (key: MaterialNumber) => () => this.material(getGlassDefaults(), this.theme.value)[key]
    const writeMaterial = (key: keyof GlassMaterial) => (value: number | string) => {
      setGlassDefaults({
        materials: {
          [this.variant]: {
            [this.theme.value]: { [key]: value },
          },
        },
      })
    }
    const readShape = (key: ShapeNumber | MorphNumber) => () => getGlassDefaults()[key]
    const writeShape = (key: ShapeNumber | MorphNumber) => (value: number) => {
      setGlassDefaults({ [key]: value })
    }

    const renderer = this.buildRendererSection(sliders)

    const [variantGroup, variants] = this.segment('variant', TEXT.material, VARIANTS, {}, (id) => {
      this.variant = id
      this.update()
    })
    const materialTitle = h('h3')
    const tintOutput = h('output')
    const tint = h('input', { 'type': 'color', 'data-field': 'tint' })
    tint.addEventListener('input', () => writeMaterial('tint')(tint.value))
    const material = this.section('material', [
      materialTitle,
      variantGroup,
      ...MATERIAL_FIELDS.map(field => this.glassSlider(sliders, field, readMaterial(field.key), writeMaterial(field.key))),
      h('label', { class: 'lg-tuner-field is-color' }, [
        this.label('span', TEXT.tint),
        tintOutput,
        tint,
      ]),
    ])

    const profileTitle = h('h3')
    const diagram = h('figure', { class: 'lg-tuner-profile' })
    const profile = this.section('profile', [
      profileTitle,
      diagram,
      ...PROFILE_FIELDS.map(field => this.glassSlider(sliders, field, readMaterial(field.key), writeMaterial(field.key))),
      this.hint(TEXT.profileHint),
    ])

    const shape = this.section('shape', [
      this.label('h3', TEXT.shape),
      ...SHAPE_FIELDS.map(field => this.glassSlider(sliders, field, readShape(field.key), writeShape(field.key))),
    ])

    const morph = this.section('morph', [
      this.label('h3', TEXT.morph),
      ...MORPH_FIELDS.map(field => this.glassSlider(sliders, field, readShape(field.key), writeShape(field.key))),
      this.hint(TEXT.morphHint),
    ])

    const close = h('button', { type: 'button', class: 'lg-tuner-close' })
    close.innerHTML = icon('close', 18)
    this.labels.push([close, TEXT.close, 'aria-label'])
    close.addEventListener('click', () => this.close())

    const reset = this.label('button', TEXT.reset, { 'type': 'button', 'data-action': 'reset' })
    reset.addEventListener('click', () => this.reset())
    const copy = h('button', { 'type': 'button', 'data-action': 'copy' })
    copy.addEventListener('click', () => void this.copy())

    const titleId = `${this.id}-title`
    const glass = h('section', {
      'class': 'lg-tuner-panel',
      'role': 'dialog',
      'aria-modal': 'false',
      'aria-labelledby': titleId,
      'data-liquid-glass': true,
      'data-glass-layer': this.layer,
      'data-glass-radius': 28,
      'data-glass-fusion': 40,
      'data-glass-variant': 'regular',
      'data-glass-morph': 'lg-tuner',
      'data-glass-blur': 28,
      'data-glass-refraction': 20,
    }, [
      h('div', { class: 'lg-tuner-content' }, [
        h('header', { class: 'lg-tuner-heading' }, [
          h('div', {}, [
            this.label('h2', TEXT.title, { id: titleId }),
            this.label('p', TEXT.subtitle),
          ]),
          close,
        ]),
        h('div', { class: 'lg-tuner-body' }, [
          renderer.section,
          material,
          profile,
          shape,
          morph,
        ]),
        h('footer', { class: 'lg-tuner-footer' }, [reset, copy]),
        this.label('p', TEXT.note, { class: 'lg-tuner-note' }),
      ]),
    ])
    return {
      anchor: h('div', { class: 'lg-tuner-anchor' }, [glass]),
      glass,
      sliders,
      variants,
      materialTitle,
      profileTitle,
      tint,
      tintOutput,
      diagram,
      diagramKey: '',
      renderer,
      copy,
    }
  }

  private buildRendererSection(sliders: Slider[]): RendererSection {
    const resolution = (key: 'maxPixelRatio' | 'maxGlassPixelRatio') => () => this.renderer?.resolution[key] ?? DEFAULT_STAGE_RESOLUTION[key]
    const setResolution = (patch: Partial<StageResolution>): void => {
      this.renderer?.setResolution(patch)
      this.update()
    }
    const ratio = (value: number): string => `${value.toFixed(2)}×`

    const [modeGroup, modes] = this.segment('mode', TEXT.renderer, MODES, {}, id => this.setMode(id))
    const errorText = h('span')
    const error = h('p', { class: 'lg-tuner-hint is-error' }, [
      this.label('span', TEXT.rendererError),
      errorText,
    ])

    const adaptive = h('input', { 'type': 'checkbox', 'data-field': 'adaptive' })
    adaptive.addEventListener('change', () => setResolution({ adaptive: adaptive.checked }))
    const adaptiveCanvas = h('input', { 'type': 'checkbox', 'data-field': 'adaptiveCanvas' })
    adaptiveCanvas.addEventListener('change', () => setResolution({
      minPixelRatio: adaptiveCanvas.checked ? 1 : Infinity,
    }))
    const [opticsGroup, optics] = this.segment('optics', TEXT.optics, OPTICS, { 'data-field': 'optics' }, (id) => {
      this.renderer?.setOptics(id)
      this.update()
    })
    const opticsHint = this.hint(null, { 'data-role': 'optics' })
    const ratios = this.hint(null, { 'data-role': 'ratios' })
    const canvas = h('div', { 'data-role': 'canvas' }, [
      this.slider(sliders, 'maxPixelRatio', TEXT.maxPixelRatio, { min: 1, max: 3, step: 0.25 }, ratio, resolution('maxPixelRatio'), value => setResolution({ maxPixelRatio: value })),
      this.slider(sliders, 'maxGlassPixelRatio', TEXT.maxGlassPixelRatio, { min: 0.5, max: 3, step: 0.25 }, ratio, resolution('maxGlassPixelRatio'), value => setResolution({ maxGlassPixelRatio: value })),
      h('label', { class: 'lg-tuner-check' }, [
        adaptive,
        this.label('span', TEXT.adaptive),
      ]),
      h('label', { class: 'lg-tuner-check' }, [
        adaptiveCanvas,
        this.label('span', TEXT.adaptiveCanvas),
      ]),
      opticsGroup,
      opticsHint,
      ratios,
    ])

    const svgHint = this.hint(TEXT.svgHint)
    const cssHint = this.hint(TEXT.cssHint)
    const unsupported = this.hint(TEXT.canvasUnsupported)
    const section = this.section('renderer', [
      this.label('h3', TEXT.renderer),
      modeGroup,
      error,
      svgHint,
      cssHint,
      unsupported,
      canvas,
    ])
    return {
      section,
      modes,
      error,
      errorText,
      svgHint,
      cssHint,
      unsupported,
      canvas,
      adaptive,
      adaptiveCanvas,
      optics,
      opticsHint,
      ratios,
    }
  }

  private setMode(mode: GlassRenderMode): void {
    const renderer = this.renderer
    if (!renderer?.setMode || renderer.switching || renderer.mode === mode)
      return
    const result = renderer.setMode(mode)
    this.update()
    void Promise.resolve(result).finally(() => this.update())
  }

  /** 恢复库内置的玻璃参数与分辨率限制。 */
  private reset(): void {
    resetGlassDefaults()
    this.renderer?.setResolution({ ...DEFAULT_STAGE_RESOLUTION })
    this.update()
  }

  /** 把当前参数复制为可以直接传给 `setGlassDefaults()` 的 JSON。 */
  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(getGlassDefaults(), null, 2))
    }
    catch {
      return
    }
    this.copied = true
    clearTimeout(this.copyTimer)
    this.copyTimer = setTimeout(() => {
      this.copied = false
      this.update()
    }, 1600)
    this.update()
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.panel)
      return
    event.stopPropagation()
    event.preventDefault()
    this.close()
  }

  /** 在点击时切换面板；拖动产生的 click 不触发展开。 */
  private readonly onLauncherClick = (event: MouseEvent): void => {
    if (this.suppressClick && event.detail !== 0) {
      this.suppressClick = false
      return
    }
    this.suppressClick = false
    this.toggle()
  }

  /** 记录拖动起点，指针移出按钮后也能完成拖动。 */
  private readonly startDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || this.gesture)
      return
    this.gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: this.position.x,
      top: this.position.y,
    }
    this.suppressClick = false
    this.launcher.setPointerCapture?.(event.pointerId)
  }

  /** 超过六像素后按拖动处理，并把按钮限制在可见范围。 */
  private readonly moveDrag = (event: PointerEvent): void => {
    const gesture = this.gesture
    if (!gesture || gesture.pointerId !== event.pointerId)
      return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!this.dragging && Math.hypot(dx, dy) < 6)
      return
    this.dragging = true
    this.suppressClick = true
    this.position = clampLauncherPosition({ x: gesture.left + dx, y: gesture.top + dy }, this.viewport, this.buttonSize())
    this.update()
  }

  /** 结束拖动；指针取消时也清理按下状态。 */
  private readonly endDrag = (event: PointerEvent): void => {
    if (this.gesture?.pointerId !== event.pointerId)
      return
    this.gesture = null
    this.dragging = false
    if (this.launcher.hasPointerCapture?.(event.pointerId))
      this.launcher.releasePointerCapture(event.pointerId)
    this.update()
  }

  /** 使用方向键移动入口，按住 Shift 时增加移动距离。 */
  private readonly moveWithKeyboard = (event: KeyboardEvent): void => {
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const offset = offsets[event.key]
    if (!offset)
      return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 16
    this.position = clampLauncherPosition({ x: this.position.x + offset[0] * step, y: this.position.y + offset[1] * step }, this.viewport, this.buttonSize())
    this.update()
  }

  /** 调整窗口后将入口移回可见区域。 */
  private readonly onResize = (): void => {
    this.viewport = { x: window.innerWidth, y: window.innerHeight }
    this.position = clampLauncherPosition(this.position, this.viewport, this.buttonSize())
    this.update()
  }
}

/**
 * 创建玻璃调参面板：一个可以拖动的圆形玻璃入口，点击后展开面板，实时修改全局默认参数
 * （`setGlassDefaults()`），提供 `mount` 或 `renderer` 时还能调整分辨率、光路和渲染方式。
 *
 * 不依赖任何前端框架。面板自带样式，颜色可以用 `--lg-tuner-*` 自定义属性覆盖。
 */
export function createGlassTuner(options: GlassTunerOptions = {}): GlassTuner {
  return new GlassTunerView(options)
}
