import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { reducedMotionQuery } from '@/shared/motion'
import { advanceSpring } from '@/shared/spring'

/** 用弹簧跟随目标值；系统要求减少动态效果时直接到达目标。 */
export function useSpring(target: () => number) {
  const value = ref(target())
  const state = { value: value.value, velocity: 0 }
  let frame = 0
  let previous = 0
  let reduced: MediaQueryList | undefined

  const tick = (now: number) => {
    const moving = advanceSpring(state, target(), (now - previous) / 1000)
    previous = now
    value.value = state.value
    frame = moving
      ? requestAnimationFrame(tick)
      : 0
  }
  const update = () => {
    if (reduced?.matches || typeof requestAnimationFrame !== 'function') {
      if (frame)
        cancelAnimationFrame(frame)
      frame = 0
      state.value = target()
      state.velocity = 0
      value.value = state.value
    }
    else if (!frame) {
      previous = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }
  onMounted(() => {
    reduced = reducedMotionQuery() ?? undefined
    reduced?.addEventListener('change', update)
  })
  watch(target, update)
  onBeforeUnmount(() => {
    if (frame)
      cancelAnimationFrame(frame)
    reduced?.removeEventListener('change', update)
  })
  return value
}
