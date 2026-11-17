import type { LiquidGlassAttributes } from './attributes'

declare module 'vue' {
  interface HTMLAttributes extends LiquidGlassAttributes {}
}
