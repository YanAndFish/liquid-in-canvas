// 这个入口不静态引入画布渲染器：它在 `mountLiquidGlass()` 确认浏览器支持后才动态加载，
// 只能使用回退实现的浏览器不会下载它。需要直接使用 `CanvasStage` 时从 `liquid-in-canvas/canvas` 引入。
export type {
  GlassNumberAttribute,
  GlassPresenceAttribute,
  GlassRadiusAttribute,
  LiquidGlassAttributes,
} from './attributes'
export type { CanvasStage, CanvasStageOptions } from './CanvasStage'
export {
  attr,
  GLASS_ATTR,
  GLASS_CLIP_ATTR,
  GLASS_FADE_ATTR,
  GLASS_MODAL_ATTR,
  GLASS_SCRIM_ATTR,
  STAGE_OVERLAY_ATTR,
} from './contract'
export { CssGlassStage } from './css/CssGlassStage'
export type { CssGlassStageOptions } from './css/CssGlassStage'
export { supportsSvgBackdropFilter } from './css/refraction'
export {
  BUILTIN_GLASS_DEFAULTS,
  getGlassDefaults,
  GLASS_LIMITS,
  onGlassDefaultsChange,
  resetGlassDefaults,
  setGlassDefaults,
} from './liquid-glass/defaults'
export type {
  GlassDefaults,
  GlassDefaultsPatch,
  GlassMaterial,
  GlassTheme,
  GlassVariant,
} from './liquid-glass/defaults'
export type { GlassOptions, GlassRadius } from './liquid-glass/options'
export { glassEdgeTilt, glassProfile, glassProfileOutline } from './liquid-glass/profile'
export type { GlassProfile, GlassProfileOptions } from './liquid-glass/profile'
export { mountLiquidGlass, StageUnsupportedError } from './mount'
export type { GlassRenderMode, LiquidGlassMount, MountLiquidGlassOptions } from './mount'
export { DEFAULT_STAGE_RESOLUTION } from './resolution'
export { detectStageSupport } from './support'
export type {
  GlassOptics,
  StageCapability,
  StageFault,
  StageMetrics,
  StageResolution,
  StageSupport,
  StageSupportReport,
} from './types'
