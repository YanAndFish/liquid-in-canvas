import type { GlassTheme } from '../liquid-glass/defaults'
import type { GlassOptions } from '../liquid-glass/options'
import type { RefractionShape } from './refraction'
import { attr, GLASS_ATTR } from '../contract'
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
  '--lg-tint',
  '--lg-radius',
  '--lg-shadow',
] as const

/**
 * 选择器带两个属性，优先级高于单个 class，玻璃元素自身的背景与阴影不会盖过回退样式。
 * 具体数值通过自定义属性逐个元素写入，样式表本身不随参数变化。
 */
const STYLE = `[${GLASS_ATTR}][${GLASS_CSS_ATTR}] {
  -webkit-backdrop-filter: blur(var(--lg-blur, 0px));
  backdrop-filter: blur(var(--lg-blur, 0px));
  background-color: var(--lg-tint, transparent);
  border-radius: var(--lg-radius, 0px);
  box-shadow: var(--lg-shadow, none);
}
[${GLASS_ATTR}][${GLASS_CSS_ATTR}="svg"] {
  backdrop-filter: blur(var(--lg-blur, 0px)) var(${FILTER_PROPERTY});
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
      attributeFilter: [GLASS_ATTR, ...GLASS_OPTION_ATTRS],
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
    // 与画布实现一致：嵌套在另一块玻璃里的元素不单独成为玻璃。
    if (this.surfaces.has(element) || !element.isConnected || element.parentElement?.closest(attr(GLASS_ATTR)))
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
    const options = parseGlassOptions(element, this.themeSource.value)
    this.applyRefraction(element, options, settled)
    // 带滤镜的玻璃由滤镜绘制轮廓高光，不再叠加内阴影。
    const properties = cssGlassProperties(options, !this.surfaces.get(element)?.signature)
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
          if (this.surfaces.has(target))
            this.apply(target)
        }
        else if (target.hasAttribute(GLASS_ATTR)) {
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
