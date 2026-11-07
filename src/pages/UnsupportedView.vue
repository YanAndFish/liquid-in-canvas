<script setup lang="ts">
import type { StageFault } from '@/stage/types'
import { computed } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useLocale } from '@/composables/useLocale'
import { useTheme } from '@/composables/useTheme'

const props = defineProps<{
  fault: StageFault
}>()

const { t, locale, setLocale } = useLocale()
const { theme, toggleTheme } = useTheme()

const LOCALES = [
  { id: 'en', short: 'EN', labelKey: 'locale.english' },
  { id: 'zh', short: '简', labelKey: 'locale.chinese' },
] as const

const title = computed(() => {
  if (props.fault.kind === 'init')
    return t('support.initTitle')
  if (props.fault.kind === 'runtime')
    return t('support.runtimeTitle')
  return t('support.title')
})

const body = computed(() => {
  if (props.fault.kind === 'init')
    return t('support.initBody')
  if (props.fault.kind === 'runtime')
    return t('support.runtimeBody')
  return t('support.body')
})

const checks = computed(() => [
  {
    label: t('support.htmlInCanvas'),
    available: props.fault.support.report.htmlInCanvas,
  },
  {
    label: t('support.webgpu'),
    available: props.fault.support.report.webgpu,
  },
  {
    label: t('support.upload'),
    available: props.fault.support.report.drawElementImageToTexture,
  },
])

const causeText = computed(() => {
  const cause = props.fault.cause
  if (cause === undefined)
    return ''
  return cause instanceof Error
    ? cause.stack ?? cause.message
    : String(cause)
})

const themeLabel = computed(() => theme.value === 'dark'
  ? t('theme.toLight')
  : t('theme.toDark'))

function reload(): void {
  if (typeof window !== 'undefined')
    window.location.reload()
}
</script>

<template>
  <div class="min-h-full flex flex-col">
    <header class="border-b border-line">
      <div class="mx-auto h-16 max-w-[1100px] flex items-center justify-between gap-4 px-5 sm:px-8">
        <span class="text-xl tracking-[0.14em] font-display">STILL</span>

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
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-[1100px] w-full flex-1 px-5 py-16 sm:px-8 sm:py-24">
      <div class="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
        <section>
          <p class="eyebrow">
            {{ t('support.eyebrow') }}
          </p>
          <h1 class="mt-4 max-w-[18ch] text-balance text-4xl leading-[1.05] font-display sm:text-5xl">
            {{ title }}
          </h1>
          <p class="mt-5 max-w-[52ch] text-sm text-mist leading-relaxed">
            {{ body }}
          </p>

          <div class="mt-8 flex flex-wrap items-center gap-3">
            <button type="button" class="btn-ghost" @click="reload">
              {{ t('support.reload') }}
            </button>
            <a
              class="btn-solid"
              href="https://www.google.com/chrome/"
              target="_blank"
              rel="noreferrer"
            >
              {{ t('support.download') }}
            </a>
            <a
              class="btn-ghost"
              href="https://developer.chrome.com/docs/web-platform/html-in-canvas"
              target="_blank"
              rel="noreferrer"
            >
              {{ t('support.docs') }}
            </a>
          </div>
        </section>

        <aside class="space-y-5">
          <div class="border border-line rounded-2xl bg-[var(--panel)] p-5">
            <p class="eyebrow">
              {{ t('support.checks') }}
            </p>
            <ul class="mt-4 space-y-3">
              <li
                v-for="check in checks"
                :key="check.label"
                class="flex items-center justify-between gap-4"
              >
                <span class="text-sm">{{ check.label }}</span>
                <span
                  class="inline-flex items-center gap-1.5 text-[10px] tracking-[0.16em] font-mono uppercase"
                  :class="check.available ? 'text-mint' : 'text-mist'"
                >
                  <AppIcon :name="check.available ? 'check' : 'close'" :size="13" />
                  {{ check.available ? t('support.available') : t('support.missing') }}
                </span>
              </li>
            </ul>
          </div>

          <div class="border border-line rounded-2xl bg-[var(--inset)] p-5">
            <p class="eyebrow">
              {{ t('support.requirementTitle') }}
            </p>
            <p class="mt-3 text-sm text-mist leading-relaxed">
              {{ t('support.requirement') }}
            </p>
            <p class="mt-4 text-[11px] text-mist font-mono">
              {{ t('support.browser') }} · {{ fault.support.report.browser }}
            </p>
          </div>

          <div v-if="causeText" class="border border-line rounded-2xl bg-[var(--panel)] p-5">
            <p class="eyebrow">
              {{ t('support.details') }}
            </p>
            <pre class="mt-3 overflow-x-auto whitespace-pre-wrap text-[11px] text-mist font-mono">{{ causeText }}</pre>
          </div>
        </aside>
      </div>
    </main>

    <footer class="border-t border-line">
      <div class="mx-auto max-w-[1100px] px-5 py-6 sm:px-8">
        <p class="text-[11px] text-mist">
          {{ t('support.note') }}
        </p>
      </div>
    </footer>
  </div>
</template>
