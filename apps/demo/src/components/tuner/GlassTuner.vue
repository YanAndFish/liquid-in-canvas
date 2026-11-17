<script setup lang="ts">
import type { GlassTuner, GlassTunerRenderer } from 'liquid-in-canvas/tuner'
import { createGlassTuner } from 'liquid-in-canvas/tuner'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { useRenderer } from '@/composables/useRenderer'

const props = defineProps<{
  disabled?: boolean
}>()

const host = ref<HTMLElement>()
const { locale } = useLocale()
const controller = useRenderer()
let tuner: GlassTuner | null = null

const renderer: GlassTunerRenderer | null = controller && {
  get mode() {
    return controller.mode.value
  },
  canvasSupported: controller.canvasSupported,
  svgSupported: controller.svgSupported,
  get switching() {
    return controller.switching.value
  },
  get error() {
    return controller.error.value
  },
  get resolution() {
    return controller.resolution.value
  },
  get optics() {
    return controller.optics.value
  },
  metrics: controller.metrics,
  setMode: controller.setMode,
  setResolution: controller.setResolution,
  setOptics: controller.setOptics,
}

onMounted(() => {
  tuner = createGlassTuner({
    container: host.value,
    renderer,
    layer: 2,
    locale: locale.value,
    hidden: props.disabled,
    zIndex: 44,
  })
})
watch(locale, next => tuner?.setLocale(next))
watch(() => props.disabled, disabled => tuner?.setHidden(disabled))
if (controller) {
  watch([
    controller.mode,
    controller.switching,
    controller.error,
    controller.resolution,
    controller.optics,
  ], () => tuner?.update())
}
onBeforeUnmount(() => {
  tuner?.destroy()
  tuner = null
})
</script>

<template>
  <div ref="host" class="contents" />
</template>
