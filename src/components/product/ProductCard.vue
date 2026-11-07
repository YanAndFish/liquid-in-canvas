<script setup lang="ts">
import type { Product } from '@/domain/types'
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { bagTargetRect, getSharedLayer } from '@/composables/sharedTransition'
import { useLocale } from '@/composables/useLocale'
import { formatCents } from '@/domain/money'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps<{
  product: Product
}>()

const emit = defineEmits<{
  add: [productId: Product['id']]
}>()

const { t, text } = useLocale()

const media = ref<HTMLElement | null>(null)
const justAdded = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

function openProduct(): void {
  const panel = media.value
  if (!panel)
    return
  getSharedLayer()?.startProductFlight({
    image: props.product.image,
    from: panel.getBoundingClientRect(),
    radius: 25.6,
  })
}

function add(): void {
  const panel = media.value
  const from = panel?.getBoundingClientRect()
  emit('add', props.product.id)
  justAdded.value = true
  clearTimeout(resetTimer)
  resetTimer = setTimeout(() => {
    justAdded.value = false
  }, 1400)
  if (from) {
    void nextTick().then(() => {
      getSharedLayer()?.flyToBag({
        image: props.product.image,
        from,
      }, bagTargetRect())
    })
  }
}

onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<template>
  <article class="group transition-transform duration-500 ease-out hover:-translate-y-1">
    <div ref="media" data-product-image class="relative aspect-[4/5] overflow-clip border border-line rounded-[1.6rem] bg-[var(--media-panel)] transition-colors duration-300 group-hover:border-[var(--line-strong)]">
      <RouterLink
        :to="{ name: 'product', params: { slug: product.slug } }"
        class="absolute inset-0 block"
        @click="openProduct"
      >
        <div class="h-full w-full transition-transform duration-700 ease-out group-hover:scale-[1.04]">
          <img
            :src="product.image"
            :alt="text(product.name)"
            class="h-full w-full object-cover"
            width="1024"
            height="1280"
            loading="lazy"
            decoding="async"
          >
        </div>
      </RouterLink>

      <span
        v-if="product.badge"
        class="pointer-events-none absolute left-4 top-4 border border-line rounded-full bg-[var(--button-glass)] px-2.5 py-1 text-[9px] text-[var(--text-soft)] tracking-[0.16em] font-mono uppercase backdrop-blur-md"
      >
        {{ text(product.badge) }}
      </span>

      <button
        type="button"
        data-liquid-glass
        data-glass-layer="0"
        data-glass-radius="999"
        data-glass-blur="12"
        data-glass-refraction="12"
        class="absolute bottom-4 right-4 inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-bone font-medium"
        :aria-label="t('product.addToBag', { name: text(product.name) })"
        @click="add"
      >
        <AppIcon
          :name="justAdded ? 'check' : 'plus'"
          :size="14"
          class="transition-transform duration-200"
          :class="justAdded ? 'scale-110' : ''"
        />
        <span>{{ justAdded ? t('product.added') : t('product.add') }}</span>
      </button>
    </div>

    <div class="mt-4 flex items-baseline justify-between gap-4">
      <h3 class="text-[15px] font-medium tracking-tight">
        <RouterLink
          :to="{ name: 'product', params: { slug: product.slug } }"
          class="transition-colors hover:text-mint"
        >
          {{ text(product.name) }}
        </RouterLink>
      </h3>
      <span class="text-[13px] text-[var(--text-soft)] font-mono tabular-nums">{{ formatCents(product.priceCents) }}</span>
    </div>
    <p class="mt-1.5 max-w-[34ch] text-[13px] text-mist leading-relaxed">
      {{ text(product.blurb) }}
    </p>
  </article>
</template>
