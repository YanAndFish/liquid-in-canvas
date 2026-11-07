<script setup lang="ts">
import type { Category, Product } from '@/domain/types'
import { computed, ref } from 'vue'
import ApproachSection from '@/components/home/ApproachSection.vue'
import CollectionSection from '@/components/home/CollectionSection.vue'
import HeroSection from '@/components/home/HeroSection.vue'
import { getProduct, PRODUCTS } from '@/domain/catalog'
import { useCart } from '@/stores/cart'

const { add } = useCart()

const activeCategory = ref<Category | 'all'>('all')
const heroProduct = getProduct('lantern-06') ?? PRODUCTS[0]

const visibleProducts = computed(() => {
  if (activeCategory.value === 'all')
    return PRODUCTS
  return PRODUCTS.filter(product => product.category === activeCategory.value)
})

function addToBag(productId: Product['id']) {
  add(productId)
}
</script>

<template>
  <HeroSection :product="heroProduct" />
  <CollectionSection
    v-model="activeCategory"
    :products="visibleProducts"
    @add="addToBag"
  />
  <ApproachSection />
</template>
