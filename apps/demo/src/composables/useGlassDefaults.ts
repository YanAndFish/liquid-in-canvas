import type { GlassDefaults } from 'liquid-in-canvas'
import { getGlassDefaults, onGlassDefaultsChange } from 'liquid-in-canvas'
import { shallowRef } from 'vue'

const defaults = shallowRef<GlassDefaults>(getGlassDefaults())

onGlassDefaultsChange((next) => {
  defaults.value = next
})

/** 以响应式引用的形式读取全局玻璃默认参数。 */
export function useGlassDefaults() {
  return { defaults }
}
