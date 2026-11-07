<script setup lang="ts">
import type { Product } from '@/domain/types'
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { CATEGORIES, PRODUCTS } from '@/domain/catalog'
import { formatCents } from '@/domain/money'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  product: Product
}>()

const { t, text, locale } = useLocale()

const position = computed(() => {
  const index = PRODUCTS.findIndex(product => product.id === props.product.id)
  return `${String(index + 1).padStart(2, '0')} / ${String(PRODUCTS.length).padStart(2, '0')}`
})
</script>

<template>
  <section class="grid items-center gap-12 pb-20 pt-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:pb-28 sm:pt-16">
    <div class="relative z-1">
      <div class="flex items-center gap-3">
        <span class="h-1.5 w-1.5 rounded-full bg-mint" />
        <p class="eyebrow">
          {{ t('hero.eyebrow') }}
        </p>
      </div>

      <h1
        class="mt-7 text-balance text-[clamp(3.4rem,9vw,7.2rem)] tracking-[-0.03em] font-display"
        :class="locale === 'zh' ? 'leading-[1.02]' : 'leading-[0.86]'"
      >
        {{ t('hero.titleLine1') }}<br>
        <span class="text-[var(--text-soft)]" :class="locale === 'en' ? 'italic' : ''">{{ t('hero.titleLine2') }}</span>
      </h1>

      <p class="mt-8 max-w-[40ch] text-[15px] text-mist leading-relaxed sm:text-base">
        {{ t('hero.subtitle') }}
      </p>

      <div class="mt-9 flex flex-wrap items-center gap-3">
        <a href="#collection" class="group btn-solid">
          {{ t('hero.cta') }}
          <AppIcon name="arrow" :size="16" class="transition-transform duration-200 group-hover:translate-x-0.5" />
        </a>
        <a href="#approach" class="btn-ghost">{{ t('hero.ctaSecondary') }}</a>
      </div>

      <dl class="grid grid-cols-3 mt-14 max-w-md gap-6 border-t border-line pt-6">
        <div>
          <dt class="field-label">
            {{ t('hero.statObjects') }}
          </dt>
          <dd class="mt-2 text-3xl font-display">
            {{ String(PRODUCTS.length).padStart(2, '0') }}
          </dd>
        </div>
        <div>
          <dt class="field-label">
            {{ t('hero.statCategories') }}
          </dt>
          <dd class="mt-2 text-3xl font-display">
            {{ String(CATEGORIES.length).padStart(2, '0') }}
          </dd>
        </div>
        <div>
          <dt class="field-label">
            {{ t('hero.statBatch') }}
          </dt>
          <dd class="mt-2 text-3xl font-display">
            01
          </dd>
        </div>
      </dl>
    </div>

    <div class="relative">
      <div class="relative aspect-[5/6] overflow-hidden border border-line rounded-[2rem] bg-[var(--media-panel)] sm:aspect-[4/5]">
        <img
          :src="product.image"
          :alt="text(product.name)"
          class="absolute inset-0 h-full w-full object-cover"
          width="1024"
          height="1280"
          fetchpriority="high"
          decoding="async"
        >
        <div class="absolute inset-x-4 bottom-4 flex items-end justify-between gap-4 border border-line rounded-2xl bg-[var(--button-glass)] p-4 backdrop-blur-md">
          <div>
            <p class="text-[9px] text-mist tracking-[0.2em] font-mono uppercase">
              {{ t('hero.heroObject') }}
            </p>
            <p class="mt-1 text-2xl font-display">
              {{ text(product.name) }}
            </p>
          </div>
          <p class="text-xs text-[var(--text-soft)] font-mono tabular-nums">
            {{ formatCents(product.priceCents) }}
          </p>
        </div>

        <span class="absolute right-5 top-5 border border-line rounded-full bg-[var(--button-glass)] px-2.5 py-1 text-[9px] text-[var(--text-soft)] tracking-[0.2em] font-mono uppercase backdrop-blur-md">{{ position }}</span>
      </div>

      <p class="mt-3 text-right text-[9px] text-mist tracking-[0.2em] font-mono uppercase">
        {{ t('hero.handFinished') }}
      </p>
    </div>
  </section>
</template>
