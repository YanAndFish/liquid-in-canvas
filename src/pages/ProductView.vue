<script setup lang="ts">
import type { Product, ProductSpecs } from '@/domain/types'
import type { MessageKey } from '@/i18n/messages'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import ProductCard from '@/components/product/ProductCard.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useLocale } from '@/composables/useLocale'
import { CATEGORY_BY_ID, getProductBySlug, PRODUCTS } from '@/domain/catalog'
import { formatCents } from '@/domain/money'
import { useCart } from '@/stores/cart'

const props = defineProps<{
  slug: string
}>()

const { t, text } = useLocale()
const { add } = useCart()

const product = computed(() => getProductBySlug(props.slug))
const categoryLabel = computed(() => {
  const value = product.value
  return value
    ? CATEGORY_BY_ID.get(value.category)?.label
    : undefined
})

const SPECS: readonly { key: keyof ProductSpecs, label: MessageKey }[] = [
  { key: 'material', label: 'spec.material' },
  { key: 'dimensions', label: 'spec.dimensions' },
  { key: 'care', label: 'spec.care' },
]

const related = computed<Product[]>(() => {
  const current = product.value
  if (!current)
    return []
  const sameCategory = PRODUCTS.filter(item => item.category === current.category && item.id !== current.id)
  const rest = PRODUCTS.filter(item => item.category !== current.category)
  return [
    ...sameCategory,
    ...rest,
  ].slice(0, 3)
})

const justAdded = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

function addToBag() {
  if (!product.value)
    return
  add(product.value.id)
  justAdded.value = true
  clearTimeout(resetTimer)
  resetTimer = setTimeout(() => {
    justAdded.value = false
  }, 1400)
}

watch(() => props.slug, () => {
  justAdded.value = false
})

onBeforeUnmount(() => clearTimeout(resetTimer))
</script>

<template>
  <div v-if="product" class="py-8 sm:py-12">
    <nav class="flex flex-wrap items-center gap-2 text-[11px] text-mist" :aria-label="t('nav.breadcrumb')">
      <RouterLink to="/" class="transition-colors hover:text-bone">{{ t('nav.home') }}</RouterLink>
      <span aria-hidden="true">/</span>
      <RouterLink :to="{ path: '/', hash: '#collection' }" class="transition-colors hover:text-bone">{{ t('nav.collection') }}</RouterLink>
      <span aria-hidden="true">/</span>
      <span class="text-[var(--text-soft)]">{{ text(product.name) }}</span>
    </nav>

    <div class="grid mt-8 gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      <div class="relative aspect-[4/5] overflow-hidden border border-line rounded-[2rem] bg-[var(--media-panel)]">
        <img
          :src="product.image"
          :alt="text(product.name)"
          class="h-full w-full object-cover"
          width="1024"
          height="1280"
          fetchpriority="high"
          decoding="async"
        >
      </div>

      <div class="lg:py-6">
        <p class="eyebrow">
          {{ categoryLabel ? text(categoryLabel) : '' }}
        </p>
        <h1 class="mt-4 text-balance text-[clamp(2.8rem,5vw,4.6rem)] leading-[0.95] font-display">
          {{ text(product.name) }}
        </h1>
        <p class="mt-4 text-sm text-[var(--text-soft)] font-mono tabular-nums">
          {{ formatCents(product.priceCents) }}
        </p>

        <p class="mt-7 max-w-[46ch] text-[15px] text-mist leading-relaxed">
          {{ text(product.blurb) }}
        </p>
        <p class="mt-4 max-w-[52ch] text-sm text-mist leading-relaxed">
          {{ text(product.details) }}
        </p>

        <button type="button" class="mt-8 btn-solid" @click="addToBag">
          {{ justAdded ? t('detail.added') : t('detail.add') }}
          <AppIcon :name="justAdded ? 'check' : 'plus'" :size="16" />
        </button>

        <div class="mt-3 text-[11px] text-mist space-y-1">
          <p>{{ t('detail.shipping') }}</p>
          <p>{{ t('detail.demo') }}</p>
        </div>

        <dl class="mt-10 border-t border-line">
          <div
            v-for="spec in SPECS"
            :key="spec.key"
            class="grid grid-cols-[8rem_1fr] gap-4 border-b border-line py-3 text-[13px]"
          >
            <dt class="text-mist">
              {{ t(spec.label) }}
            </dt>
            <dd>{{ text(product.specs[spec.key]) }}</dd>
          </div>
        </dl>

        <RouterLink :to="{ path: '/', hash: '#collection' }" class="mt-8 inline-flex items-center gap-2 text-[13px] text-mist transition-colors hover:text-bone">
          <AppIcon name="arrow" :size="14" class="rotate-180" />
          {{ t('detail.back') }}
        </RouterLink>
      </div>
    </div>

    <section class="mt-20 border-t border-line pt-10">
      <h2 class="text-3xl font-display">
        {{ t('detail.related') }}
      </h2>
      <div class="grid grid-cols-1 mt-8 gap-x-6 gap-y-12 lg:grid-cols-3 sm:grid-cols-2">
        <ProductCard
          v-for="item in related"
          :key="item.id"
          :product="item"
          @add="add"
        />
      </div>
    </section>
  </div>

  <div v-else class="min-h-[60vh] flex flex-col items-center justify-center py-24 text-center">
    <p class="eyebrow">
      404
    </p>
    <h1 class="mt-4 text-balance text-4xl font-display">
      {{ t('detail.notFound') }}
    </h1>
    <p class="mt-4 max-w-[34ch] text-sm text-mist">
      {{ t('detail.notFoundBody') }}
    </p>
    <RouterLink :to="{ path: '/', hash: '#collection' }" class="mt-8 btn-solid">
      {{ t('detail.back') }}
    </RouterLink>
  </div>
</template>
