<script setup lang="ts">
import type { IconName } from './icons'
import { ICONS } from './icons'

withDefaults(defineProps<{
  name: IconName
  size?: number
}>(), {
  size: 18,
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="ICONS[name]" />
  </svg>
</template>
