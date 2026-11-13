/**
 * 画布渲染器本身，会静态引入 three.js。
 *
 * 一般通过主入口的 `mountLiquidGlass()` 使用，它在需要时动态加载这个模块。
 * 只有自己管理画布和挂载过程时才需要从这里引入 `CanvasStage`。
 */
export { CanvasStage } from './CanvasStage'
export type { CanvasStageOptions } from './CanvasStage'
