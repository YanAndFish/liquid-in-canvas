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

export const GLASS_CSS_ATTR = 'data-liquid-glass-css'

const FILTER_PROPERTY = '--lg-filter'

const RESIZE_SETTLE = 140

interface CssSurface {
  signature: string | null
  width: number
  height: number
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

export const FALLBACK_MIN_BLUR = 10

export const FALLBACK_MIN_VEIL = 0.24

const LIGHT_VEIL = '#f6f6f8'
const DARK_VEIL = '#14181c'

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
    const nested = !!element.parentElement?.closest(attr(GLASS_ATTR))
    const legible = nested
      ? options
      : legibleOptions(options, getComputedStyle(element).color, theme)
    const properties = cssGlassProperties(legible, !this.surfaces.get(element)?.signature)
    for (const name of PROPERTIES) {
      if (element.style.getPropertyValue(name) !== properties[name])
        element.style.setProperty(name, properties[name])
    }
  }

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

  private setFilter(element: HTMLElement, surface: CssSurface, shape: RefractionShape | null): void {
    const filters = this.filters
    if (!filters || (shape && refractionSignature(shape)) === surface.signature)
      return
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
