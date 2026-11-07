<script setup lang="ts">
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import CartDrawer from '@/components/cart/CartDrawer.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'
import SiteHeader from '@/components/layout/SiteHeader.vue'
import { useLocale } from '@/composables/useLocale'
import { useCart } from '@/stores/cart'

const { totals } = useCart()
const { t } = useLocale()

const cartOpen = ref(false)
</script>

<template>
  <div class="min-h-screen">
    <a
      href="#main"
      class="sr-only z-50 rounded-full bg-bone px-4 py-2 text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
    >
      {{ t('nav.skip') }}
    </a>

    <SiteHeader :count="totals.itemCount" @open-cart="cartOpen = true" />

    <main id="main" tabindex="-1" class="mx-auto max-w-[1240px] px-5 sm:px-8">
      <RouterView />
    </main>

    <SiteFooter />
    <CartDrawer v-model:open="cartOpen" />
  </div>
</template>
