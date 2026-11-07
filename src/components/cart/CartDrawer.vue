<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useLocale } from '@/composables/useLocale'
import { formatCents, FREE_SHIPPING_CENTS } from '@/domain/money'
import { setStageScrollLocked } from '@/stage/scroll'
import { useCart } from '@/stores/cart'
import AppIcon from '../ui/AppIcon.vue'
import CartLineRow from './CartLineRow.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const { lines, totals, increment, decrement, remove, clear } = useCart()
const { t } = useLocale()

const phase = ref<'bag' | 'placing' | 'confirmed'>('bag')
const panel = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)

let checkoutTimer: ReturnType<typeof setTimeout> | undefined
let lastFocused: HTMLElement | null = null

const meterWidth = computed(() => {
  const progress = (totals.value.subtotalCents / FREE_SHIPPING_CENTS) * 100
  return `${Math.min(100, progress)}%`
})

const freeShippingHint = computed(() => {
  if (totals.value.freeShipping)
    return t('cart.freeShipping')
  return t('cart.freeShippingAway', {
    amount: formatCents(totals.value.remainingForFreeShippingCents),
  })
})

function close() {
  emit('update:open', false)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }

  if (event.key !== 'Tab' || !panel.value)
    return

  const focusable = Array.from(
    panel.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
  ).filter(element => element.offsetParent !== null)

  if (!focusable.length)
    return

  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  }
  else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function checkout() {
  if (!totals.value.itemCount || phase.value !== 'bag')
    return

  phase.value = 'placing'
  checkoutTimer = setTimeout(() => {
    clear()
    phase.value = 'confirmed'
  }, 800)
}

watch(() => props.open, async (open) => {
  if (open) {
    lastFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    phase.value = 'bag'
    setStageScrollLocked(true)
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    closeButton.value?.focus()
  }
  else {
    setStageScrollLocked(false)
    document.removeEventListener('keydown', onKeydown)
    clearTimeout(checkoutTimer)
    phase.value = 'bag'
    lastFocused?.focus()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  setStageScrollLocked(false)
  document.removeEventListener('keydown', onKeydown)
  clearTimeout(checkoutTimer)
})
</script>

<template>
  <Transition name="cart">
    <div v-if="props.open" class="fixed inset-0 z-50">
      <div class="absolute inset-0 bg-[var(--scrim)] backdrop-blur-sm" @click="close" />

      <aside
        ref="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-title"
        class="absolute inset-y-0 right-0 max-w-[26rem] w-full flex flex-col border-l border-line bg-coal shadow-[-24px_0_80px_var(--drawer-shadow)]"
      >
        <header class="flex items-center justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
          <div>
            <p class="eyebrow">
              {{ t('cart.selection') }}
            </p>
            <h2 id="cart-title" class="mt-1 text-2xl font-display">
              {{ phase === 'confirmed' ? t('cart.orderPlaced') : t('cart.bag') }}
            </h2>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="border border-line rounded-full p-2.5 text-mist transition-colors hover:border-[var(--line-strong)] hover:text-bone"
            :aria-label="t('cart.close')"
            @click="close"
          >
            <AppIcon name="close" :size="16" />
          </button>
        </header>

        <div v-if="phase === 'confirmed'" class="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span class="h-14 w-14 flex items-center justify-center border border-[var(--accent-line)] rounded-full bg-[var(--accent-soft)] text-mint">
            <AppIcon name="check" :size="24" />
          </span>
          <h3 class="mt-6 text-3xl font-display">
            {{ t('cart.thanks') }}
          </h3>
          <p class="mt-3 max-w-[21rem] text-sm text-mist leading-relaxed">
            {{ t('cart.demoBody') }}
          </p>
          <button type="button" class="mt-8 btn-ghost" @click="close">
            {{ t('cart.continue') }}
          </button>
        </div>

        <div v-else-if="!lines.length" class="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span class="h-14 w-14 flex items-center justify-center border border-line rounded-full text-mist">
            <AppIcon name="bag" :size="22" />
          </span>
          <h3 class="mt-6 text-3xl font-display">
            {{ t('cart.emptyTitle') }}
          </h3>
          <p class="mt-3 max-w-[21rem] text-sm text-mist leading-relaxed">
            {{ t('cart.emptyBody') }}
          </p>
          <RouterLink :to="{ path: '/', hash: '#collection' }" class="mt-8 btn-solid" @click="close">
            {{ t('cart.browse') }}
          </RouterLink>
        </div>

        <template v-else>
          <div class="flex-1 overflow-y-auto px-5 sm:px-6">
            <ul class="divide-y divide-line">
              <CartLineRow
                v-for="(line, index) in lines"
                :key="line.product.id"
                :line="line"
                class="cart-line"
                :style="{ animationDelay: `${index * 40}ms` }"
                @increment="increment(line.product.id)"
                @decrement="decrement(line.product.id)"
                @remove="remove(line.product.id)"
              />
            </ul>
          </div>

          <footer class="border-t border-line px-5 py-5 sm:px-6">
            <div class="border border-line rounded-2xl bg-[var(--inset)] p-3">
              <p class="text-[11px] text-mist leading-relaxed">
                {{ freeShippingHint }}
              </p>
              <div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--track)]">
                <div class="h-full rounded-full bg-mint transition-all duration-500" :style="{ width: meterWidth }" />
              </div>
            </div>

            <dl class="mt-5 text-sm space-y-2">
              <div class="flex items-center justify-between">
                <dt class="text-mist">
                  {{ t('cart.subtotal') }}
                </dt>
                <dd class="font-mono tabular-nums">
                  {{ formatCents(totals.subtotalCents) }}
                </dd>
              </div>
              <div class="flex items-center justify-between">
                <dt class="text-mist">
                  {{ t('cart.shipping') }}
                </dt>
                <dd class="font-mono tabular-nums">
                  {{ totals.shippingCents ? formatCents(totals.shippingCents) : t('cart.free') }}
                </dd>
              </div>
              <div class="flex items-center justify-between border-t border-line pt-3 text-base">
                <dt>{{ t('cart.total') }}</dt>
                <dd class="font-mono tabular-nums">
                  {{ formatCents(totals.totalCents) }}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              class="mt-5 w-full btn-solid"
              :disabled="phase === 'placing'"
              @click="checkout"
            >
              {{ phase === 'placing' ? t('cart.placing') : t('cart.checkout') }}
            </button>
            <p class="mt-3 text-center text-[10px] text-mist">
              {{ t('cart.demoCheckout') }}
            </p>
          </footer>
        </template>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.cart-enter-active,
.cart-leave-active {
  transition: opacity 240ms ease;
}

.cart-enter-active aside,
.cart-leave-active aside {
  transition: transform 320ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

.cart-enter-from,
.cart-leave-to {
  opacity: 0;
}

.cart-enter-from aside,
.cart-leave-to aside {
  transform: translateX(100%);
}

.cart-line {
  animation: cart-line-in 360ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

@keyframes cart-line-in {
  from {
    opacity: 0;
    transform: translateX(14px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
