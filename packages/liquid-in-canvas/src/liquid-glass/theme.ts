import type { GlassTheme } from './defaults'

/**
 * 解析玻璃使用的主题，并在它变化时通知。
 *
 * 优先级：调用方固定的主题 → `<html data-theme="light|dark">` → 系统配色。
 */
export class GlassThemeSource {
  private fixed: GlassTheme | null
  private readonly onChange: () => void
  private observer: MutationObserver | null = null
  private colorScheme: MediaQueryList | null = null

  constructor(onChange: () => void, fixed: GlassTheme | null = null) {
    this.onChange = onChange
    this.fixed = fixed
  }

  /** 开始监听页面主题与系统配色。 */
  start(): void {
    if (this.observer || typeof document === 'undefined')
      return
    this.observer = new MutationObserver(this.onChange)
    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    this.colorScheme = typeof matchMedia === 'function'
      ? matchMedia('(prefers-color-scheme: light)')
      : null
    this.colorScheme?.addEventListener?.('change', this.onChange)
  }

  stop(): void {
    this.observer?.disconnect()
    this.observer = null
    this.colorScheme?.removeEventListener?.('change', this.onChange)
    this.colorScheme = null
  }

  /** 固定主题，传入 null 恢复跟随页面。 */
  set(theme: GlassTheme | null): void {
    if (this.fixed === theme)
      return
    this.fixed = theme
    this.onChange()
  }

  get value(): GlassTheme {
    if (this.fixed)
      return this.fixed
    if (typeof document === 'undefined')
      return 'dark'
    const declared = document.documentElement.dataset.theme
    if (declared === 'light' || declared === 'dark')
      return declared
    return this.colorScheme?.matches
      ? 'light'
      : 'dark'
  }
}
