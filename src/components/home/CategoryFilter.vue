<script setup lang="ts">
import type { Category } from '@/domain/types'
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { CATEGORIES, countByCategory, PRODUCTS } from '@/domain/catalog'

type FilterValue = Category | 'all'

const props = defineProps<{
  modelValue: FilterValue
}>()

const emit = defineEmits<{
  'update:modelValue': [value: FilterValue]
}>()

const { t, text } = useLocale()

const options = computed(() => [
  {
    id: 'all' as const,
    label: t('filter.all'),
    count: PRODUCTS.length,
  },
  ...CATEGORIES.map(category => ({
    id: category.id,
    label: text(category.label),
    count: countByCategory(category.id),
  })),
])

function pad(value: number) {
  return String(value).padStart(2, '0')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('filter.label')">
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="inline-flex items-center gap-2 border rounded-full px-3.5 py-2 text-[13px] transition-all duration-200 active:scale-95"
      :class="props.modelValue === option.id
        ? 'border-bone bg-bone text-ink'
        : 'border-line text-mist hover:border-[var(--line-strong)] hover:text-bone'"
      :aria-pressed="props.modelValue === option.id"
      @click="emit('update:modelValue', option.id)"
    >
      {{ option.label }}
      <span class="text-[9px] font-mono tabular-nums opacity-55">{{ pad(option.count) }}</span>
    </button>
  </div>
</template>
