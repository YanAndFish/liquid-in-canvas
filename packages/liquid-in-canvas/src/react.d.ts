// 给 React JSX 里的原生元素加上 `data-liquid-glass`、`data-glass-*` 等属性的类型。只有类型，没有运行时代码。
// 用法：tsconfig 的 `compilerOptions.types` 加上 "liquid-in-canvas/react"，
// 或在任意 .d.ts 里写 `/// <reference types="liquid-in-canvas/react" />`。
import type { LiquidGlassAttributes } from './attributes'

declare module 'react' {
  // 类型参数必须与 React 的声明一致才能合并。
  interface HTMLAttributes<T> extends LiquidGlassAttributes {}
}
