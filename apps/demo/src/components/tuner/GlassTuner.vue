<script setup lang="ts">
import type { GlassTuner, GlassTunerRenderer } from 'liquid-in-canvas/tuner'
import { createGlassTuner } from 'liquid-in-canvas/tuner'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { useRenderer } from '@/composables/useRenderer'

const props = defineProps<{
  /** 购物袋等模态界面打开时隐藏调参入口。 */
  disabled?: boolean
}>()

const host = ref<HTMLElement>()
const { locale } = useLocale()
const controller = useRenderer()
let tuner: GlassTuner | null = null

/** 把启动代码提供的响应式控制器转成面板读取的接口；面板按需读取 getter。 */
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
  // 面板插入应用的 DOM 之内，画布模式下随根元素一起进入画布。主题跟随 <html data-theme>。
  tuner = createGlassTuner({
    container: host.value,
    renderer,
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
