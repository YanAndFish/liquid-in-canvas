<script setup lang="ts">
import type { CartLineItem } from '@/domain/types'
import { useLocale } from '@/composables/useLocale'
import { formatCents } from '@/domain/money'
import AppIcon from './AppIcon.vue'

defineProps<{
  line: CartLineItem
}>()

const emit = defineEmits<{
  increment: []
  decrement: []
  remove: []
}>()

const { t, text } = useLocale()
</script>

<template>
  <li class="flex gap-4 py-5">
    <div class="h-20 w-16 shrink-0 overflow-hidden border border-line rounded-xl bg-[var(--media-panel)]">
      <img :src="line.product.image" alt="" class="h-full w-full object-cover">
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-medium">
            {{ text(line.product.name) }}
          </p>
          <p class="mt-0.5 text-[10px] text-mist tracking-[0.14em] font-mono uppercase">
            {{ t('product.each', { price: formatCents(line.product.priceCents) }) }}
          </p>
        </div>
        <p class="text-xs text-[var(--text-soft)] font-mono tabular-nums">
          {{ formatCents(line.lineTotalCents) }}
        </p>
      </div>

      <div class="mt-3 flex items-center justify-between gap-3">
        <div class="inline-flex items-center border border-line rounded-full">
          <button
            type="button"
            class="h-8 w-8 flex items-center justify-center rounded-full text-mist transition-colors hover:text-bone"
            :aria-label="t('product.decrease', { name: text(line.product.name) })"
            @click="emit('decrement')"
          >
            <AppIcon name="minus" :size="13" />
          </button>
          <span class="w-6 text-center text-[11px] font-mono tabular-nums" aria-live="polite">
            {{ line.quantity }}
          </span>
          <button
            type="button"
            class="h-8 w-8 flex items-center justify-center rounded-full text-mist transition-colors hover:text-bone"
            :aria-label="t('product.increase', { name: text(line.product.name) })"
            @click="emit('increment')"
          >
            <AppIcon name="plus" :size="13" />
          </button>
        </div>

        <button
          type="button"
          class="text-[11px] text-mist underline-offset-4 transition-colors hover:text-bone hover:underline"
          :aria-label="t('product.removeFromBag', { name: text(line.product.name) })"
          @click="emit('remove')"
        >
          {{ t('product.remove') }}
        </button>
      </div>
    </div>
  </li>
</template>
