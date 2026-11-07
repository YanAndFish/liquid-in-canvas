<script setup lang="ts">
import { ref } from 'vue'
import { RouterView } from 'vue-router'
import CartDrawer from '@/components/cart/CartDrawer.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'
import SiteHeader from '@/components/layout/SiteHeader.vue'
import FloatingSupport from '@/components/support/FloatingSupport.vue'
import SharedTransitionLayer from '@/components/transition/SharedTransitionLayer.vue'
import { getSharedLayer } from '@/composables/sharedTransition'
import { useLocale } from '@/composables/useLocale'
import { useCart } from '@/stores/cart'

const { totals } = useCart()
const { t } = useLocale()

const cartOpen = ref(false)

function finalRect(element: Element, target: HTMLElement): DOMRect {
  const rect = target.getBoundingClientRect()
  const transform = getComputedStyle(element).transform
  const offset = transform === 'none' || typeof DOMMatrix === 'undefined'
    ? 0
    : new DOMMatrix(transform).f
  return new DOMRect(rect.x, rect.y - offset, rect.width, rect.height)
}

function onPageEnter(element: Element): void {
  const target = (element as HTMLElement).querySelector<HTMLElement>('[data-product-image]')
  if (!target)
    return
  const layer = getSharedLayer()
  if (!layer)
    return
  const started = layer.completeProductFlight(
    () => {
      if (!target.isConnected)
        return null
      const scroller = document.getElementById('stage-scroll')
      if (scroller && scroller.scrollTop !== 0)
        return null
      return finalRect(element, target)
    },
    32,
    () => {
      target.style.visibility = ''
    },
  )
  if (started)
    target.style.visibility = 'hidden'
}
</script>

<template>
  <div id="stage-scroll" class="h-full overflow-y-auto overscroll-none">
    <div class="min-h-full flex flex-col">
      <a
        href="#main"
        class="sr-only z-50 rounded-full bg-bone px-4 py-2 text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {{ t('nav.skip') }}
      </a>

      <SiteHeader :count="totals.itemCount" @open-cart="cartOpen = true" />

      <main id="main" tabindex="-1" class="mx-auto max-w-[1440px] w-full flex-1 px-3 sm:px-8">
        <div class="page-stage">
          <RouterView v-slot="{ Component, route }">
            <Transition name="page" @enter="onPageEnter">
              <div :key="route.path" class="page-view">
                <component :is="Component" />
              </div>
            </Transition>
          </RouterView>
        </div>
      </main>

      <SiteFooter />
    </div>
  </div>

  <FloatingSupport :disabled="cartOpen" />
  <SharedTransitionLayer />
  <CartDrawer v-model:open="cartOpen" />
</template>
