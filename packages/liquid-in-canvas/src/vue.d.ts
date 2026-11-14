// 给 Vue 模板里的原生元素加上 `data-liquid-glass`、`data-glass-*` 等属性的类型。只有类型，没有运行时代码。
// 用法：tsconfig 的 `compilerOptions.types` 加上 "liquid-in-canvas/vue"，
// 或在任意 .d.ts 里写 `/// <reference types="liquid-in-canvas/vue" />`。
import type { LiquidGlassAttributes } from './attributes'

declare module 'vue' {
  interface HTMLAttributes extends LiquidGlassAttributes {}
}
