<script setup lang="ts">
import type { Locale } from '@/domain/types'
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { useTheme } from '@/composables/useTheme'
import AppIcon from './AppIcon.vue'

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
  <header class="sticky top-0 z-40 border-b border-line bg-[var(--header-bg)] backdrop-blur-xl">
    <div class="mx-auto h-16 max-w-[1240px] flex items-center justify-between gap-4 px-5 sm:px-8">
      <a href="#" class="flex items-baseline gap-2.5">
        <span class="text-xl tracking-[0.14em] font-display">STILL</span>
        <span class="hidden text-[9px] text-mist tracking-[0.26em] font-mono uppercase sm:inline">{{ t('brand.tagline') }}</span>
      </a>

      <nav class="hidden items-center gap-8 text-[13px] text-mist md:flex" :aria-label="t('nav.primary')">
        <a href="#collection" class="transition-colors hover:text-bone">{{ t('nav.collection') }}</a>
        <a href="#approach" class="transition-colors hover:text-bone">{{ t('nav.approach') }}</a>
      </nav>

      <div class="flex items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          class="border border-line rounded-full p-2 text-mist transition-colors hover:border-[var(--line-strong)] hover:text-bone"
          :aria-label="themeLabel"
          :title="themeLabel"
          @click="toggleTheme"
        >
          <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" />
        </button>

        <div class="flex items-center border border-line rounded-full p-0.5" role="group" :aria-label="t('locale.label')">
          <button
            v-for="option in LOCALES"
            :key="option.id"
            type="button"
            class="rounded-full px-2 py-1 text-[10px] leading-none font-mono transition-colors"
            :class="locale === option.id ? 'bg-bone text-ink' : 'text-mist hover:text-bone'"
            :aria-label="t(option.labelKey)"
            :aria-pressed="locale === option.id"
            @click="setLocale(option.id)"
          >
            {{ option.short }}
          </button>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 border border-line rounded-full px-3.5 py-2 text-[13px] text-bone transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover)]"
          :aria-label="bagLabel"
          @click="emit('openCart')"
        >
          <AppIcon name="bag" :size="16" />
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
