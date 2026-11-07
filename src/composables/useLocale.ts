import type { Locale, LocalizedText } from '@/domain/types'
import type { MessageKey } from '@/i18n/messages'
import type { MessageParams } from '@/i18n/translate'
import { computed, ref, watch } from 'vue'
import { messages } from '@/i18n/messages'
import { translate } from '@/i18n/translate'

export const LOCALE_STORAGE_KEY = 'still.locale'

function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined')
    return null
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return stored === 'en' || stored === 'zh'
      ? stored
      : null
  }
  catch {
    return null
  }
}

function preferredLocale(): Locale {
  const stored = readStoredLocale()
  if (stored)
    return stored
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh'))
    return 'zh'
  return 'en'
}

const locale = ref<Locale>(preferredLocale())

watch(locale, (value) => {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = value === 'zh'
      ? 'zh-CN'
      : 'en'
    document.title = messages['meta.title'][value]
    document.querySelector('meta[name="description"]')?.setAttribute('content', messages['meta.description'][value])
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, value)
    }
    catch {

    }
  }
}, { immediate: true })

export function useLocale() {
  const isChinese = computed(() => locale.value === 'zh')

  function t(key: MessageKey, params?: MessageParams): string {
    return translate(key, locale.value, params)
  }

  function text(value: LocalizedText): string {
    return value[locale.value]
  }

  function setLocale(next: Locale): void {
    locale.value = next
  }

  return {
    locale,
    isChinese,
    t,
    text,
    setLocale,
  }
}
