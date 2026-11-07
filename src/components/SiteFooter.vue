<script setup lang="ts">
import { useLocale } from '@/composables/useLocale'

const { t } = useLocale()
</script>

<template>
  <footer class="border-t border-line">
    <div class="mx-auto max-w-[1240px] flex flex-col gap-8 px-5 py-10 md:flex-row md:items-center md:justify-between sm:px-8">
      <div>
        <p class="text-lg tracking-[0.14em] font-display">
          STILL
        </p>
        <p class="mt-2 text-xs text-mist">
          {{ t('footer.tagline') }}
        </p>
      </div>

      <nav class="flex gap-6 text-xs text-mist" :aria-label="t('nav.footer')">
        <a href="#collection" class="transition-colors hover:text-bone">{{ t('nav.collection') }}</a>
        <a href="#approach" class="transition-colors hover:text-bone">{{ t('nav.approach') }}</a>
      </nav>
    </div>

    <div class="mx-auto max-w-[1240px] px-5 pb-10 sm:px-8">
      <p class="border-t border-line pt-6 text-[11px] text-mist leading-relaxed">
        {{ t('footer.note') }}
      </p>
    </div>
  </footer>
</template>
