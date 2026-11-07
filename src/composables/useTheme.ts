import { computed, ref, watch } from 'vue'

export type Theme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'still.theme'

function storedTheme(): Theme | null {
  if (typeof window === 'undefined')
    return null
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark'
      ? stored
      : null
  }
  catch {
    return null
  }
}

function initialTheme(): Theme {
  if (typeof document !== 'undefined') {
    const fromDocument = document.documentElement.dataset.theme
    if (fromDocument === 'light' || fromDocument === 'dark')
      return fromDocument
  }

  const stored = storedTheme()
  if (stored)
    return stored

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches)
    return 'light'

  return 'dark'
}

const theme = ref<Theme>(initialTheme())

watch(theme, (value) => {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'light'
      ? '#f4f1ea'
      : '#08080a')
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, value)
    }
    catch {

    }
  }
}, { immediate: true })

export function useTheme() {
  const isDark = computed(() => theme.value === 'dark')

  function toggleTheme(): void {
    theme.value = theme.value === 'dark'
      ? 'light'
      : 'dark'
  }

  return { theme, isDark, toggleTheme }
}
