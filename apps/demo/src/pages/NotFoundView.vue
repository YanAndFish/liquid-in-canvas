<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useLocale } from '@/composables/useLocale'

const { t } = useLocale()
</script>

<template>
  <div class="min-h-[60vh] flex flex-col items-center justify-center py-24 text-center">
    <p class="eyebrow">
      404
    </p>
    <h1 class="mt-4 text-balance text-4xl font-display">
      {{ t('notFound.title') }}
    </h1>
    <p class="mt-4 max-w-[34ch] text-sm text-mist">
      {{ t('notFound.body') }}
    </p>
    <RouterLink to="/" class="mt-8 btn-solid">
      {{ t('notFound.action') }}
    </RouterLink>
  </div>
</template>
