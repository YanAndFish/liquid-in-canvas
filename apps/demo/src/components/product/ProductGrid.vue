<script setup lang="ts">
import type { Product } from '@/domain/types'
import { useLocale } from '@/composables/useLocale'
import ProductCard from './ProductCard.vue'

defineProps<{
  products: readonly Product[]
}>()

const emit = defineEmits<{
  add: [productId: Product['id']]
}>()

const { t } = useLocale()
</script>

<template>
  <div>
    <div v-if="products.length" class="grid grid-cols-1 gap-x-6 gap-y-12 lg:grid-cols-3 sm:grid-cols-2">
      <ProductCard
        v-for="product in products"
        :key="product.id"
        :product="product"
        @add="emit('add', $event)"
      />
    </div>

    <div v-else class="border border-line rounded-[1.6rem] px-6 py-20 text-center">
      <p class="text-2xl font-display">
        {{ t('grid.emptyTitle') }}
      </p>
      <p class="mt-2 text-sm text-mist">
        {{ t('grid.emptyBody') }}
      </p>
    </div>
  </div>
</template>
