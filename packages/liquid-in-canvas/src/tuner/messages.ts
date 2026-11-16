import type { GlassMaterial, GlassVariant } from '../liquid-glass/defaults'
import type { GlassRenderMode } from '../mount'
import type { GlassOptics } from '../types'

/** 面板文案的语言。 */
export type GlassTunerLocale = 'zh' | 'en'

export type Text = readonly [zh: string, en: string]

export type MaterialNumber = Exclude<keyof GlassMaterial, 'tint'>
export type ShapeNumber = 'fusion' | 'elevation' | 'radius'
export type MorphNumber = 'morphStretch' | 'morphBounce' | 'morphWobble'

export interface Field<Key extends string> {
  key: Key
  label: Text
  step: number
  max?: number
  unit?: string
}

export const MATERIAL_FIELDS: readonly Field<MaterialNumber>[] = [
  {
    key: 'blur',
    label: ['模糊', 'Blur'],
    step: 1,
    unit: 'px',
  },
  {
    key: 'dispersion',
    label: ['色散', 'Dispersion'],
    step: 0.01,
  },
  {
    key: 'ior',
    label: ['折射率', 'Refractive index'],
    step: 0.01,
  },
  {
    key: 'lens',
    label: ['透镜放大', 'Magnification'],
    step: 0.01,
  },
  {
    key: 'saturation',
    label: ['饱和度', 'Saturation'],
    step: 0.05,
    unit: '×',
  },
  {
    key: 'brightness',
    label: ['亮度', 'Brightness'],
    step: 0.01,
    unit: '×',
  },
  {
    key: 'tintAlpha',
    label: ['染色浓度', 'Tint amount'],
    step: 0.01,
  },
  {
    key: 'specular',
    label: ['高光', 'Specular'],
    step: 0.01,
  },
  {
    key: 'shadow',
    label: ['阴影', 'Shadow'],
    step: 0.01,
  },
  {
    key: 'shadowSize',
    label: ['阴影范围', 'Shadow size'],
    step: 1,
    unit: 'px',
  },
]

export const PROFILE_FIELDS: readonly Field<MaterialNumber>[] = [
  {
    key: 'refraction',
    label: ['半厚度', 'Half thickness'],
    step: 1,
    unit: 'px',
  },
  {
    key: 'bevelWidth',
    label: ['倒角宽度', 'Bevel width'],
    step: 0.01,
    unit: '×',
  },
  {
    key: 'bevelHeight',
    label: ['倒角高度', 'Bevel height'],
    step: 0.01,
    unit: '×',
  },
  {
    key: 'bevelCurve',
    label: ['曲线指数', 'Edge curve'],
    step: 0.05,
  },
  {
    key: 'bottomBevel',
    label: ['底面倒角', 'Bottom bevel'],
    step: 0.01,
  },
]

export const SHAPE_FIELDS: readonly Field<ShapeNumber>[] = [
  {
    key: 'fusion',
    label: ['融合距离', 'Fusion distance'],
    step: 1,
    unit: 'px',
  },
  {
    key: 'elevation',
    label: ['悬浮高度', 'Elevation'],
    step: 1,
    unit: 'px',
  },
  {
    key: 'radius',
    label: ['圆角', 'Corner radius'],
    step: 1,
    max: 64,
    unit: 'px',
  },
]

export const MORPH_FIELDS: readonly Field<MorphNumber>[] = [
  {
    key: 'morphStretch',
    label: ['拉伸', 'Stretch'],
    step: 0.01,
  },
  {
    key: 'morphBounce',
    label: ['回弹', 'Bounce'],
    step: 0.01,
  },
  {
    key: 'morphWobble',
    label: ['晃动', 'Wobble'],
    step: 0.01,
  },
]

export const VARIANTS: readonly { id: GlassVariant, label: Text }[] = [
  {
    id: 'regular',
    label: ['柔和', 'Regular'],
  },
  {
    id: 'clear',
    label: ['通透', 'Clear'],
  },
]

export const MODES: readonly { id: GlassRenderMode, label: Text }[] = [
  {
    id: 'canvas',
    label: ['画布', 'Canvas'],
  },
  {
    id: 'svg',
    label: ['SVG 滤镜', 'SVG filter'],
  },
  {
    id: 'css',
    label: ['纯 CSS', 'CSS only'],
  },
]

export const OPTICS: readonly { id: GlassOptics, label: Text, hint: Text }[] = [
  {
    id: 'profile',
    label: ['剖面', 'Profile'],
    hint: ['剖面光学：按截面查表折射，开销最低；融合连接处与比倒角窄的圆角是近似。', 'Profile optics: refraction looked up along the cross-section, cheapest; fused joints and corners tighter than the bevel are approximate.'],
  },
  {
    id: 'hybrid',
    label: ['混合', 'Hybrid'],
    hint: ['混合光路：融合连接处、裁剪边附近与比倒角窄的圆角静止后求交一次并缓存，运动中与其余像素查表。', 'Hybrid optics: fused joints, clip edges and corners tighter than the bevel are ray-marched once at rest and cached; looked up while moving and elsewhere.'],
  },
  {
    id: 'raymarch',
    label: ['求交', 'Ray march'],
    hint: ['三维求交：所有倒角与融合区域逐步求交，开销最高。', 'Ray marching: every bevel and fused region is marched in 3D, most expensive.'],
  },
]

export const TEXT = {
  title: ['玻璃调参', 'Glass tuning'],
  subtitle: ['全局默认参数 · 实时生效', 'Global defaults · applied live'],
  close: ['关闭调参面板', 'Close tuning panel'],
  launcherTitle: ['拖动移动，点击调参；方向键也可以移动', 'Drag to move, click to tune; arrow keys also move'],
  renderer: ['渲染方式', 'Renderer'],
  rendererError: ['画布启动失败，已改用回退实现：', 'The canvas failed to start; using the fallback: '],
  svgHint: ['SVG 滤镜回退：backdrop-filter 加位移贴图，有边缘折射与色散；透镜放大、融合、抬升和内容遮挡不起作用。', 'SVG filter fallback: backdrop-filter with a displacement map gives edge refraction and dispersion. Magnification, fusion, elevation and content occlusion have no effect.'],
  cssHint: ['纯 CSS 回退只有模糊、染色、阴影和轮廓高光，厚度、色散、透镜放大、融合不起作用。', 'The CSS-only fallback has blur, tint, shadow and an edge highlight. Thickness, dispersion, magnification and fusion have no effect.'],
  canvasUnsupported: ['这个浏览器缺少 HTML-in-Canvas 或 WebGPU，不能使用画布渲染。', 'This browser lacks HTML-in-Canvas or WebGPU, so canvas rendering is unavailable.'],
  maxPixelRatio: ['画布倍率上限（文字）', 'Max canvas ratio (text)'],
  maxGlassPixelRatio: ['玻璃着色倍率上限', 'Max glass shading ratio'],
  adaptive: ['帧率不足时自动降级：先改用剖面光学，再降低玻璃着色倍率；不见效的一级会撤回', 'When frames drop, fall back to profile optics, then lower the glass shading ratio; a step that does not help is undone'],
  adaptiveCanvas: ['仍然不足时降低画布倍率（文字变软，最低 1×）', 'If that is not enough, lower the canvas ratio (softer text, down to 1×)'],
  optics: ['光路', 'Optics'],
  canvasNow: ['当前画布', 'Canvas now'],
  loweredFrom: ['（已自动降低，原为', '(lowered from'],
  loweredEnd: ['）', ')'],
  glassShading: ['玻璃着色', 'glass shading'],
  opticsLowered: ['光路已自动降为剖面', 'optics lowered to profile'],
  material: ['材质', 'Material'],
  darkTheme: ['深色主题', 'dark theme'],
  lightTheme: ['浅色主题', 'light theme'],
  tint: ['染色', 'Tint color'],
  profile: ['截面', 'Cross-section'],
  profileHint: ['倒角宽高按半厚度的倍数计；曲线指数 1 是直线斜面，2 是椭圆弧，越大越方。小控件的厚度不超过短边的 30%。', 'Bevel width and height are multiples of the half thickness. Edge curve 1 is a straight chamfer, 2 an elliptical arc, higher values get squarer. Small controls cap thickness at 30% of their short side.'],
  shape: ['形体', 'Shape'],
  morph: ['液体流动', 'Liquid flow'],
  morphHint: ['作用于声明了 data-glass-morph 的玻璃，例如拖动这个面板的圆形入口。只对画布渲染有效。', 'Applies to glass with data-glass-morph, such as this panel\'s round button while you drag it. Canvas rendering only.'],
  reset: ['恢复默认', 'Reset'],
  copy: ['复制参数', 'Copy JSON'],
  copied: ['已复制', 'Copied'],
  note: ['只影响没有用 data-glass-* 单独声明的属性。拖动圆形按钮可以移动面板。', 'Only affects properties without their own data-glass-* attribute. Drag the round button to move the panel.'],
} satisfies Record<string, Text>

export function detectLocale(): GlassTunerLocale {
  const lang = (typeof document !== 'undefined' && document.documentElement.lang)
    || (typeof navigator !== 'undefined' && navigator.language)
    || ''
  return lang.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en'
}
