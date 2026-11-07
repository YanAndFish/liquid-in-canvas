<script setup lang="ts">
import type { Locale } from '@/domain/types'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useLocale } from '@/composables/useLocale'
import { useTheme } from '@/composables/useTheme'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  count: number
}>()

const emit = defineEmits<{
  openCart: []
}>()

const { t, locale, setLocale } = useLocale()
const { theme, toggleTheme } = useTheme()

const LOCALES = [
  { id: 'en', short: 'EN', labelKey: 'locale.english' },
  { id: 'zh', short: '简', labelKey: 'locale.chinese' },
] as const satisfies readonly { id: Locale, short: string, labelKey: 'locale.english' | 'locale.chinese' }[]

const bagLabel = computed(() => props.count > 0
  ? `${t('nav.bag')}${props.count}`
  : t('nav.bag'))

const themeLabel = computed(() => theme.value === 'dark'
  ? t('theme.toLight')
  : t('theme.toDark'))
</script>

<template>
  <header class="site-header">
    <div class="header-layout">
      <RouterLink to="/" class="flex items-baseline gap-2.5">
        <span class="text-xl tracking-[0.14em] font-display">STILL</span>
        <span class="hidden text-[9px] text-mist tracking-[0.26em] font-mono uppercase sm:inline">{{ t('brand.tagline') }}</span>
      </RouterLink>

      <nav data-liquid-glass data-glass-radius="999" data-glass-blur="20" data-glass-refraction="12" data-glass-shadow="0.12" data-glass-shadow-size="16" class="header-nav" :aria-label="t('nav.primary')">
        <RouterLink :to="{ path: '/', hash: '#collection' }" class="transition-colors hover:text-bone link-underline">{{ t('nav.collection') }}</RouterLink>
        <RouterLink :to="{ path: '/', hash: '#approach' }" class="transition-colors hover:text-bone link-underline">{{ t('nav.approach') }}</RouterLink>
      </nav>

      <div class="header-actions" data-liquid-glass data-glass-radius="999" data-glass-blur="20" data-glass-refraction="12" data-glass-shadow="0.12" data-glass-shadow-size="16">
        <button
          type="button"
          class="header-icon"
          :aria-label="themeLabel"
          :title="themeLabel"
          @click="toggleTheme"
        >
          <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" />
        </button>

        <div class="header-locale" role="group" :aria-label="t('locale.label')">
          <button
            v-for="option in LOCALES"
            :key="option.id"
            type="button"
            class="locale-option"
            :class="locale === option.id ? 'is-selected' : ''"
            :aria-label="t(option.labelKey)"
            :aria-pressed="locale === option.id"
            @click="setLocale(option.id)"
          >
            {{ option.short }}
          </button>
        </div>

        <button
          type="button"
          class="header-bag"
          :aria-label="bagLabel"
          @click="emit('openCart')"
        >
          <span data-bag-target class="inline-flex items-center justify-center">
            <AppIcon name="bag" :size="16" />
          </span>
          <span class="hidden sm:inline">{{ t('nav.bag') }}</span>
          <span
            v-if="count > 0"
            class="min-w-5 inline-flex items-center justify-center rounded-full bg-mint px-1.5 py-0.5 text-[10px] text-ink font-semibold leading-none font-mono"
            aria-hidden="true"
          >
            {{ count }}
          </span>
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.site-header { position: sticky; top: 0; z-index: 40; padding: 18px 0 16px; pointer-events: none; }
.site-header::before { content: ''; position: absolute; inset: 0 0 -12px; z-index: -1; background: linear-gradient(var(--bg), transparent); pointer-events: none; }
.header-layout { position: relative; max-width: 1440px; margin: 0 auto; padding: 0 32px; height: 52px; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.header-layout > * { pointer-events: auto; }
.header-nav { display: flex; height: 52px; align-items: center; padding: 6px; border-radius: 999px; gap: 2px; font-size: 13px; font-weight: 550; }
.header-nav a { display: flex; align-items: center; min-height: 40px; padding: 0 22px; border-radius: 999px; text-decoration: none; }
.header-nav a:hover { background: var(--hover); }
.header-nav a::after { display: none; }
.header-actions { display: flex; height: 52px; align-items: center; gap: 2px; padding: 4px; border-radius: 999px; }
.header-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; }
.header-locale { display: flex; align-items: center; gap: 2px; }
.locale-option { min-width: 38px; height: 40px; font-size: 11px; border-radius: 999px; }
.locale-option.is-selected { background: var(--hover); font-weight: 700; }
.header-bag { height: 44px; display: flex; align-items: center; padding: 0 14px; gap: 8px; font-size: 13px; border-radius: 999px; }
button { cursor: pointer; }
button:hover { background: var(--hover); }
@media (max-width: 760px) {
  .header-layout { padding: 0 18px; gap: 8px; }
  .header-nav { display: none; }
  .header-bag { padding: 0 10px; }
  .locale-option { min-width: 32px; }
}
</style>
