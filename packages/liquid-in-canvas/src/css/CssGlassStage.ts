import type { GlassTheme } from '../liquid-glass/defaults'
import type { GlassOptions } from '../liquid-glass/options'
import type { RefractionShape } from './refraction'
import { attr, GLASS_ATTR, GLASS_SCOPE_ATTR, hasAttr } from '../contract'
import { onGlassDefaultsChange } from '../liquid-glass/defaults'
import { GLASS_OPTION_ATTRS, parseGlassOptions } from '../liquid-glass/options'
import { GlassThemeSource } from '../liquid-glass/theme'
import { RefractionFilters, refractionShape, refractionSignature, supportsSvgBackdropFilter } from './refraction'

export interface CssGlassStageOptions {
  /** 页面根元素，其中的 `[data-liquid-glass]` 会获得回退样式。 */
  root: HTMLElement
  /** 固定玻璃主题；缺省时读取 `<html data-theme>`，再退回系统配色。 */
  theme?: GlassTheme
  /**
   * 是否用 SVG 滤镜模拟边缘折射与色散。缺省在浏览器支持时启用；
   * 浏览器不支持时即使传入 true 也不会启用，见 `supportsSvgBackdropFilter()`。
   */
  refraction?: boolean
}

/**
 * 标记已应用回退样式的元素，样式表只对带有它的玻璃生效。
 * 值为 `svg` 时这块玻璃另外带有折射滤镜。
 */
export const GLASS_CSS_ATTR = 'data-liquid-glass-css'

const FILTER_PROPERTY = '--lg-filter'

/** 尺寸停止变化这么久之后才重新生成折射滤镜，单位毫秒。 */
const RESIZE_SETTLE = 140

/** 一块已处理的玻璃。 */
interface CssSurface {
  /** 当前折射滤镜的签名，没有滤镜时为 null。 */
  signature: string | null
  /** 上一次处理时的布局尺寸，取整到 CSS 像素。 */
  width: number
  height: number
  /** 尺寸正在变化时，等待重新生成滤镜的计时器。 */
  settle: ReturnType<typeof setTimeout> | undefined
}

const STYLE_ID = 'liquid-in-canvas-css'
const PROPERTIES = [
  '--lg-blur',
  '--lg-saturation',
  '--lg-brightness',
  '--lg-tint',
  '--lg-radius',
  '--lg-shadow',
] as const

/**
 * 选择器带两个属性，优先级高于单个 class，玻璃元素自身的背景与阴影不会盖过回退样式。
 * 具体数值通过自定义属性逐个元素写入，样式表本身不随参数变化。
 */
const STYLE = `[${GLASS_ATTR}][${GLASS_CSS_ATTR}] {
  -webkit-backdrop-filter: blur(var(--lg-blur, 0px)) saturate(var(--lg-saturation, 1)) brightness(var(--lg-brightness, 1));
  backdrop-filter: blur(var(--lg-blur, 0px)) saturate(var(--lg-saturation, 1)) brightness(var(--lg-brightness, 1));
  background-color: var(--lg-tint, transparent);
  border-radius: var(--lg-radius, 0px);
  box-shadow: var(--lg-shadow, none);
}
[${GLASS_ATTR}][${GLASS_CSS_ATTR}="svg"] {
  backdrop-filter: blur(var(--lg-blur, 0px)) saturate(var(--lg-saturation, 1)) brightness(var(--lg-brightness, 1)) var(${FILTER_PROPERTY});
}
@media (prefers-reduced-transparency: reduce) {
  [${GLASS_ATTR}][${GLASS_CSS_ATTR}] {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    background-color: color-mix(in srgb, var(--lg-tint, transparent), Canvas 70%);
  }
}`

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${value >> 16 & 255}, ${value >> 8 & 255}, ${value & 255}, ${Math.round(alpha * 1000) / 1000})`
}

/**
 * 回退实现里背景模糊的下限，单位 CSS 像素。
 *
 * 画布里的倒角把边缘一圈背景压缩、折开，中间也随厚度轻微放大，玻璃上的文字下面不会是原样的背景细节；
 * 回退实现没有这些，通透材质直接把视频、照片的细节压在文字下面。
 */
export const FALLBACK_MIN_BLUR = 10

/** 回退实现里衬底不透明度的下限：染色不足时补到这么多。 */
export const FALLBACK_MIN_VEIL = 0.24

/** 承托深色文字的浅色衬底与承托浅色文字的深色衬底。 */
const LIGHT_VEIL = '#f6f6f8'
const DARK_VEIL = '#14181c'

/** 解析 `rgb()` / `rgba()` 形式的计算颜色，返回相对亮度（0–1）；无法解析时返回 null。 */
export function colorLuminance(color: string): number | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color)
  if (!match)
    return null
  const linear = (value: string | undefined): number => {
    const c = Number(value) / 255
    return c <= 0.04045
      ? c / 12.92
      : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(match[1]) + 0.7152 * linear(match[2]) + 0.0722 * linear(match[3])
}

function mixHex(a: string, b: string, t: number): string {
  const x = Number.parseInt(a.slice(1), 16)
  const y = Number.parseInt(b.slice(1), 16)
  let out = 0
  for (const shift of [16, 8, 0])
    out |= Math.round((x >> shift & 255) * (1 - t) + (y >> shift & 255) * t) << shift
  return `#${out.toString(16).padStart(6, '0')}`
}

/**
 * 回退实现的可读性底线：模糊不低于 `FALLBACK_MIN_BLUR`，染色不足 `FALLBACK_MIN_VEIL` 时补一层衬底。
 *
 * 衬底颜色按玻璃上文字的明暗选择：浅色文字配深色衬底，深色文字配浅色衬底。
 * 视频上用白字的控件因此不会被浅色主题的白雾冲淡。原有染色按比例保留在衬底里。
 * `textColor` 无法解析时按主题选择：深色主题配深色衬底。
 */
export function legibleOptions(options: GlassOptions, textColor: string | null, theme: GlassTheme): GlassOptions {
  const blur = Math.max(options.blur, FALLBACK_MIN_BLUR)
  if (options.tintAlpha >= FALLBACK_MIN_VEIL) {
    return blur === options.blur
      ? options
      : { ...options, blur }
  }
  const luminance = textColor
    ? colorLuminance(textColor)
    : null
  const light = luminance === null
    ? theme === 'dark'
    : luminance > 0.4
  const veil = light ? DARK_VEIL : LIGHT_VEIL
  return {
    ...options,
    blur,
    tint: mixHex(veil, options.tint, options.tintAlpha / FALLBACK_MIN_VEIL),
    tintAlpha: FALLBACK_MIN_VEIL,
  }
}

/**
 * 把玻璃参数换算成 CSS 能表达的部分：模糊、染色、圆角、阴影和一圈高光。
 *
 * `highlight` 为 false 时不输出内阴影高光，用于已经由折射滤镜绘制高光的玻璃。
 */
export function cssGlassProperties(options: GlassOptions, highlight = true): Record<typeof PROPERTIES[number], string> {
  const strength = Math.min(1, options.specular * 0.2)
  const shadows = highlight
    ? [
        `inset 0 0 0 1px rgba(255, 255, 255, ${Math.round(strength * 500) / 1000})`,
        `inset 0 1px 0 0 rgba(255, 255, 255, ${Math.round(strength * 1000) / 1000})`,
      ]
    : []
  if (options.shadow > 0 && options.shadowSize > 0)
    shadows.push(`0 4px ${Math.round(options.shadowSize * 0.75)}px rgba(0, 0, 0, ${Math.round(options.shadow * 600) / 1000})`)
  return {
    '--lg-blur': `${options.blur}px`,
    '--lg-saturation': String(options.saturation),
    '--lg-brightness': String(options.brightness),
    '--lg-tint': rgba(options.tint, options.tintAlpha),
    '--lg-radius': options.radius.map(value => `${value}px`).join(' '),
    '--lg-shadow': shadows.join(', ') || 'none',
  }
}

/**
 * 不依赖 HTML-in-Canvas 与 WebGPU 的回退实现。
 *
 * 页面保持普通 DOM，玻璃用 `backdrop-filter` 近似：模糊、染色、圆角、阴影与轮廓高光。
 * 浏览器支持把 SVG 滤镜用作 `backdrop-filter` 时，再用位移贴图加上边缘折射与色散。
 * 没有同层融合、内容遮挡和按压形变。读取同一套 `data-glass-*` 属性与全局默认参数，
 * 因此在几种实现之间切换不需要改动页面。
 */
export class CssGlassStage {
  /** 是否使用 SVG 滤镜模拟折射。 */
  readonly refraction: boolean
  private readonly root: HTMLElement
  private readonly themeSource: GlassThemeSource
  private readonly surfaces = new Map<HTMLElement, CssSurface>()
  private readonly filters: RefractionFilters | null
  private resizeObserver: ResizeObserver | null = null
  private observer: MutationObserver | null = null
  private stopDefaults: (() => void) | null = null
  private style: HTMLStyleElement | null = null
  private started = false
  private disposed = false

  constructor(options: CssGlassStageOptions) {
    this.root = options.root
    this.refraction = (options.refraction ?? true) && supportsSvgBackdropFilter()
    this.filters = this.refraction
      ? new RefractionFilters()
      : null
    this.themeSource = new GlassThemeSource(() => this.refreshAll(), options.theme ?? null)
  }

  start(): void {
    if (this.started || this.disposed)
      return
    this.started = true
    this.installStyle()
    this.themeSource.start()
    this.stopDefaults = onGlassDefaultsChange(() => this.refreshAll())
    // 滤镜的位移贴图按元素尺寸生成，尺寸变化后需要换一张。
    if (this.filters && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (this.surfaces.has(entry.target as HTMLElement))
            this.apply(entry.target as HTMLElement)
        }
      })
    }
    this.observer = new MutationObserver(records => this.handleMutations(records))
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [GLASS_ATTR, GLASS_SCOPE_ATTR, ...GLASS_OPTION_ATTRS],
    })
    for (const element of this.root.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
      this.register(element)
  }

  /** 固定玻璃主题，传入 null 恢复跟随页面。 */
  setTheme(theme: GlassTheme | null): void {
    this.themeSource.set(theme)
  }

  /** 移除回退样式，页面恢复到挂载前的状态。 */
  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.themeSource.stop()
    this.stopDefaults?.()
    this.stopDefaults = null
    for (const element of [
      ...this.surfaces.keys(),
    ])
      this.unregister(element)
    this.filters?.dispose()
    this.style?.remove()
    this.style = null
  }

  private installStyle(): void {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    document.head.append(style)
    this.style = style
  }

  private register(element: HTMLElement): void {
    // 嵌套玻璃（例如激活的标签项）在回退实现里是外层之上的一层染色与模糊。
    if (this.surfaces.has(element) || !element.isConnected)
      return
    this.surfaces.set(element, {
      signature: null,
      width: -1,
      height: -1,
      settle: undefined,
    })
    element.setAttribute(GLASS_CSS_ATTR, '')
    this.apply(element)
    this.resizeObserver?.observe(element)
  }

  private unregister(element: HTMLElement): void {
    const surface = this.surfaces.get(element)
    if (surface?.signature)
      this.filters?.release(surface.signature)
    clearTimeout(surface?.settle)
    this.surfaces.delete(element)
    this.resizeObserver?.unobserve(element)
    element.removeAttribute(GLASS_CSS_ATTR)
    element.style.removeProperty(FILTER_PROPERTY)
    for (const name of PROPERTIES)
      element.style.removeProperty(name)
  }

  private apply(element: HTMLElement, settled = false): void {
    const theme = this.themeSource.value
    const options = parseGlassOptions(element, theme)
    this.applyRefraction(element, options, settled)
    // 嵌套玻璃（激活项）下面已经有外层的衬底，不再补。
    const nested = !!element.parentElement?.closest(attr(GLASS_ATTR))
    const legible = nested
      ? options
      : legibleOptions(options, getComputedStyle(element).color, theme)
    // 带滤镜的玻璃由滤镜绘制轮廓高光，不再叠加内阴影。
    const properties = cssGlassProperties(legible, !this.surfaces.get(element)?.signature)
    for (const name of PROPERTIES) {
      if (element.style.getPropertyValue(name) !== properties[name])
        element.style.setProperty(name, properties[name])
    }
  }

  /**
   * 按当前参数与尺寸更换折射滤镜。
   *
   * 尺寸变化时先撤下滤镜、只留模糊，停止变化后再按新尺寸生成（`settled` 为 true 的那次调用）。
   * 位移贴图是一张按元素尺寸生成的图片，带尺寸动画的面板如果每帧换一张，
   * 解码与滤镜重建会把动画拖到三十帧以下。参数变化不改变尺寸，立即生效。
   */
  private applyRefraction(element: HTMLElement, options: GlassOptions, settled: boolean): void {
    const surface = this.surfaces.get(element)
    if (!this.filters || !surface)
      return
    const width = Math.round(element.offsetWidth)
    const height = Math.round(element.offsetHeight)
    const resized = surface.signature !== null && (width !== surface.width || height !== surface.height)
    surface.width = width
    surface.height = height
    if (!settled && (resized || surface.settle !== undefined)) {
      clearTimeout(surface.settle)
      this.setFilter(element, surface, null)
      surface.settle = setTimeout(() => {
        surface.settle = undefined
        if (this.surfaces.get(element) === surface)
          this.apply(element, true)
      }, RESIZE_SETTLE)
      return
    }
    this.setFilter(element, surface, refractionShape(options, width, height))
  }

  /** 换上形状对应的滤镜，null 表示只保留模糊；形状没有变化时不动。 */
  private setFilter(element: HTMLElement, surface: CssSurface, shape: RefractionShape | null): void {
    const filters = this.filters
    if (!filters || (shape && refractionSignature(shape)) === surface.signature)
      return
    // 先取得新滤镜再释放旧的，共用同一个滤镜的玻璃不会让它被回收后重建。
    const acquired = shape && filters.acquire(shape)
    if (acquired) {
      element.style.setProperty(FILTER_PROPERTY, `url(#${acquired.id})`)
      element.setAttribute(GLASS_CSS_ATTR, 'svg')
    }
    else {
      element.style.removeProperty(FILTER_PROPERTY)
      element.setAttribute(GLASS_CSS_ATTR, '')
    }
    if (surface.signature)
      filters.release(surface.signature)
    surface.signature = acquired?.signature ?? null
  }

  private refreshAll(): void {
    for (const element of this.surfaces.keys())
      this.apply(element)
  }

  private handleMutations(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as HTMLElement
        if (record.attributeName !== GLASS_ATTR) {
          // 参数可能写在作用域上，作用域内的玻璃都要重新读取。
          for (const element of this.surfaces.keys()) {
            if (target.contains(element))
              this.apply(element)
          }
        }
        else if (hasAttr(target, GLASS_ATTR)) {
          this.register(target)
        }
        else if (this.surfaces.has(target)) {
          this.unregister(target)
        }
        continue
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement))
          continue
        if (node.matches(attr(GLASS_ATTR)))
          this.register(node)
        for (const element of node.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
          this.register(element)
      }
      if (record.removedNodes.length) {
        for (const element of [
          ...this.surfaces.keys(),
        ]) {
          if (!element.isConnected)
            this.unregister(element)
        }
      }
    }
  }
}
