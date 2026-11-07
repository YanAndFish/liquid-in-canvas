<script setup lang="ts">
import type { MessageKey } from '@/i18n/messages'
import { useLocale } from '@/composables/useLocale'

const STEPS: readonly { n: string, title: MessageKey, body: MessageKey }[] = [
  { n: '01', title: 'approach.material.title', body: 'approach.material.body' },
  { n: '02', title: 'approach.maker.title', body: 'approach.maker.body' },
  { n: '03', title: 'approach.care.title', body: 'approach.care.body' },
]

const { t } = useLocale()
</script>

<template>
  <section id="approach" class="scroll-mt-24 pb-24 pt-10 sm:pb-32">
    <div class="grid gap-12 border-t border-line pt-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
      <div>
        <p class="eyebrow">
          {{ t('approach.eyebrow') }}
        </p>
        <h2 class="mt-4 max-w-[18ch] text-balance text-[clamp(2.2rem,4vw,3.4rem)] leading-[1.02] font-display">
          {{ t('approach.title') }}
        </h2>
      </div>

      <ol class="grid gap-10 sm:grid-cols-3 sm:gap-6">
        <li v-for="step in STEPS" :key="step.n">
          <span class="text-[10px] text-mist tracking-[0.18em] font-mono">{{ step.n }}</span>
          <h3 class="mt-3 text-sm font-medium">
            {{ t(step.title) }}
          </h3>
          <p class="mt-2 text-[13px] text-mist leading-relaxed">
            {{ t(step.body) }}
          </p>
        </li>
      </ol>
    </div>
  </section>
</template>
