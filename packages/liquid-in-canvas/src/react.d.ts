import type { LiquidGlassAttributes } from './attributes'

declare module 'react' {
  interface HTMLAttributes<T> extends LiquidGlassAttributes {}
}
