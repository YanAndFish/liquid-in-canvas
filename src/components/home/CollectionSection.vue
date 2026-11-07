<script setup lang="ts">
import type { Category, Product } from '@/domain/types'
import { useLocale } from '@/composables/useLocale'
import { PRODUCTS } from '@/domain/catalog'
import ProductGrid from '../product/ProductGrid.vue'
import CategoryFilter from './CategoryFilter.vue'

type FilterValue = Category | 'all'

defineProps<{
  products: readonly Product[]
  modelValue: FilterValue
}>()

const emit = defineEmits<{
  'update:modelValue': [value: FilterValue]
  'add': [productId: Product['id']]
}>()

const { t } = useLocale()
</script>

<template>
  <section id="collection" class="scroll-mt-24 py-20 sm:py-28">
    <div class="flex flex-col gap-8 border-t border-line pt-8 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="eyebrow">
          {{ t('collection.eyebrow', { count: String(PRODUCTS.length).padStart(2, '0') }) }}
        </p>
        <h2 class="mt-4 text-balance text-[clamp(2.4rem,5vw,4rem)] leading-[0.95] font-display">
          {{ t('collection.title') }}
        </h2>
      </div>
      <CategoryFilter
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>

    <ProductGrid class="mt-12" :products="products" @add="emit('add', $event)" />
  </section>
</template>
