<script setup lang="ts">
import type { Category } from '@/domain/types'
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { useSpring } from '@/composables/useSpring'
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

const selection = useSpring(() => options.value.findIndex(option => option.id === props.modelValue))

/** 将商品数量显示为两位数。 */
function pad(value: number) {
  return String(value).padStart(2, '0')
}
</script>

<template>
  <div class="filter-anchor">
    <div class="category-filter" data-liquid-glass data-glass-radius="999" data-glass-shadow="0.12" data-glass-shadow-size="18" role="group" :aria-label="t('filter.label')">
      <span class="filter-selection" :style="{ transform: `translateX(${selection * 100}%)` }" aria-hidden="true" />
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        :aria-pressed="props.modelValue === option.id"
        @click="emit('update:modelValue', option.id)"
      >
        {{ option.label }}
        <span class="filter-count">{{ pad(option.count) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.filter-anchor { position: relative; width: 420px; max-width: 100%; }
.category-filter { display: flex; height: 56px; width: 100%; padding: 6px; border-radius: 999px; }
.category-filter button { position: relative; z-index: 1; flex: 1; min-width: 0; border-radius: 999px; display: flex; align-items: center; justify-content: center; gap: 7px; font-size: 13px; cursor: pointer; }
.category-filter button:hover { background: var(--hover); }
.category-filter button[aria-pressed='true'] { font-weight: 600; }
.filter-selection { position: absolute; top: 6px; left: 6px; height: 44px; width: calc((100% - 12px) / 4); border-radius: 999px; background: var(--hover); box-shadow: inset 0 1px 0 var(--line); }
.filter-count { opacity: .55; font-size: 10px; font-variant-numeric: tabular-nums; }
@media (max-width: 380px) { .category-filter button { font-size: 12px; gap: 4px; } }
</style>
