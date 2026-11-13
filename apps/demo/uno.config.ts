import { defineConfig, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss'

export default defineConfig({
  presets: [
    presetWind3(),
  ],
  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
  theme: {
    colors: {
      ink: 'var(--bg)',
      coal: 'var(--panel)',
      slate: 'var(--surface)',
      bone: 'var(--text)',
      mist: 'var(--muted)',
      mint: 'var(--accent)',
      line: 'var(--line)',
    },
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Noto Sans SC", sans-serif',
      display: '"Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Noto Serif SC", Georgia, serif',
      mono: '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
    },
  },
  shortcuts: {
    'btn': 'inline-flex items-center justify-center gap-2 rounded-full font-sans text-sm font-medium tracking-tight transition-all duration-200 select-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40',
    'btn-solid': 'btn bg-bone text-ink px-5 py-3 hover:bg-[var(--solid-hover)] active:bg-[var(--solid-active)]',
    'btn-ghost': 'btn border border-line px-5 py-3 text-bone hover:border-[var(--line-strong)] hover:bg-[var(--hover)]',
    'eyebrow': 'font-mono text-[10px] uppercase tracking-[0.24em] text-mist',
    'field-label': 'font-mono text-[10px] uppercase tracking-[0.18em] text-mist',
  },
})
