<script setup lang="ts">
import type { Category, Product } from '@/domain/types'
import { computed, ref } from 'vue'
import { useCart } from '@/composables/useCart'
import { useLocale } from '@/composables/useLocale'
import { getProduct, PRODUCTS } from '@/domain/catalog'
import ApproachSection from './components/ApproachSection.vue'
import CartDrawer from './components/CartDrawer.vue'
import CollectionSection from './components/CollectionSection.vue'
import HeroSection from './components/HeroSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'

const { totals, dispatch } = useCart()
const { t } = useLocale()

const cartOpen = ref(false)
const activeCategory = ref<Category | 'all'>('all')
const heroProduct = getProduct('lantern-06') ?? PRODUCTS[0]

const visibleProducts = computed(() => {
  if (activeCategory.value === 'all')
    return PRODUCTS
  return PRODUCTS.filter(product => product.category === activeCategory.value)
})

function addToBag(productId: Product['id']) {
  dispatch({ type: 'add', productId })
}
</script>

<template>
  <div class="min-h-screen">
    <a
      href="#collection"
      class="sr-only z-50 rounded-full bg-bone px-4 py-2 text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
    >
      {{ t('nav.skip') }}
    </a>

    <SiteHeader :count="totals.itemCount" @open-cart="cartOpen = true" />

    <main class="mx-auto max-w-[1240px] px-5 sm:px-8">
      <HeroSection :product="heroProduct" />
      <CollectionSection
        v-model="activeCategory"
        :products="visibleProducts"
        @add="addToBag"
      />
      <ApproachSection />
    </main>

    <SiteFooter />
    <CartDrawer v-model:open="cartOpen" />
  </div>
</template>
