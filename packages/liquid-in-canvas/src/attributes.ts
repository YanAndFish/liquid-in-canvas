/**
 * 页面上 `data-*` 属性的类型，只有类型，没有运行时代码。
 *
 * 属性在运行时都按字符串读取（见 `liquid-glass/options.ts` 与 `contract.ts`），这里给出各属性接受的写法，
 * 供 JSX 或模板做补全和检查。框架的属性类型扩展见 `liquid-in-canvas/vue` 与 `liquid-in-canvas/react`；
 * 其他场景可以直接使用 `LiquidGlassAttributes`，例如给自己的组件属性加上这些键。
 *
 * 数值超出范围时被限制在范围之内，无法解析时取全局默认值，见 `GLASS_LIMITS` 与 `setGlassDefaults()`。
 */

/** 数值属性：数字，或写在模板里的数字字符串。 */
export type GlassNumberAttribute = number | `${number}`

/** 圆角：一至四个值，按 CSS 的顺序（左上、右上、右下、左下）展开，可用空格或逗号分隔。 */
export type GlassRadiusAttribute
  = | GlassNumberAttribute
    | `${number} ${number}`
    | `${number} ${number} ${number}`
    | `${number} ${number} ${number} ${number}`
    | `${number},${number}`
    | `${number},${number},${number}`
    | `${number},${number},${number},${number}`

/**
 * 只看是否存在的属性：写成空字符串，或在 JSX、Vue 模板里不写值。
 * 不接受 `false`：框架会把它渲染成字符串 `"false"`，属性仍然存在。不需要时绑定 `undefined` 或 `null`。
 */
export type GlassPresenceAttribute = '' | true

/** 声明液态玻璃及其参数的属性。长度单位都是 CSS 像素，缺省一栏写作 `regular / clear`。 */
export interface LiquidGlassAttributes {
  /** 声明一块液态玻璃。 */
  'data-liquid-glass'?: GlassPresenceAttribute | null
  /** 材质：`regular` 使用较强模糊与主题染色，`clear` 保留更多背景细节，决定其他材质参数的缺省值。缺省 `regular`。 */
  'data-glass-variant'?: 'regular' | 'clear' | null
  /** 圆角，0–2000。缺省 28。 */
  'data-glass-radius'?: GlassRadiusAttribute | null
  /** 背景高斯模糊的标准差，0–80。缺省 18 / 2。 */
  'data-glass-blur'?: GlassNumberAttribute | null
  /** 三维实体的半厚度上限，0–80。实际厚度为短边的 0.3 倍，不超过这个值。缺省 80。 */
  'data-glass-refraction'?: GlassNumberAttribute | null
  /** 边缘倒角的水平宽度，按半厚度的倍数，0.1–4。缺省 0.45。 */
  'data-glass-bevel-width'?: GlassNumberAttribute | null
  /** 边缘倒角的垂直高度，按半厚度的倍数，0.05–1；1 表示侧面没有竖直部分。缺省 1。 */
  'data-glass-bevel-height'?: GlassNumberAttribute | null
  /** 倒角曲线的超椭圆指数，1–8：1 是直线斜面，2 是椭圆弧，越大越接近直角。缺省 3。 */
  'data-glass-bevel-curve'?: GlassNumberAttribute | null
  /** 底面倒角相对顶面倒角的比例，0–1；0 表示底面是带直角边的平面。缺省 1。 */
  'data-glass-bottom-bevel'?: GlassNumberAttribute | null
  /** RGB 取样分离强度，0–1。缺省 0.3 / 0.4。 */
  'data-glass-dispersion'?: GlassNumberAttribute | null
  /** 凸透镜强度，0–0.6，只对画布渲染有效。缺省 0.04 / 0.12。 */
  'data-glass-lens'?: GlassNumberAttribute | null
  /** 透射背景的饱和度倍数，0–3。缺省 1.3 / 1.15。 */
  'data-glass-saturation'?: GlassNumberAttribute | null
  /** 透射背景的亮度倍数，0.5–1.5。缺省随主题。 */
  'data-glass-brightness'?: GlassNumberAttribute | null
  /** 十六进制染色值，`#rgb` 或 `#rrggbb`。缺省随主题。 */
  'data-glass-tint'?: `#${string}` | null
  /** 染色比例，0–1。缺省随主题。 */
  'data-glass-tint-alpha'?: GlassNumberAttribute | null
  /** 轮廓高光强度，0–2，只对画布渲染有效。缺省 0.7 / 0.9。 */
  'data-glass-specular'?: GlassNumberAttribute | null
  /** 外侧阴影强度，0–1。缺省 0.16 / 0.12。 */
  'data-glass-shadow'?: GlassNumberAttribute | null
  /** 阴影范围，0–100。缺省 32 / 28。 */
  'data-glass-shadow-size'?: GlassNumberAttribute | null
  /** 玻璃层级，−100–100 的整数，值越大越靠前，只有同层玻璃会融合。缺省 0。 */
  'data-glass-layer'?: GlassNumberAttribute | null
  /** 融合距离，0–100，0 表示关闭。缺省 32。 */
  'data-glass-fusion'?: GlassNumberAttribute | null
  /** 玻璃底面到背景的距离，0–100。缺省 16。 */
  'data-glass-elevation'?: GlassNumberAttribute | null
  /** 用于定位的祖先选择器。缺省使用 `offsetParent`。 */
  'data-glass-anchor'?: string | null
  /** 液体迁移，只对画布渲染有效。空值表示自身位置或尺寸变化时流动过去，非空值同时是迁移的名字。缺省关闭。 */
  'data-glass-morph'?: string | true | null
  /** 液体迁移的拉伸，0–2。缺省来自全局默认参数。 */
  'data-glass-morph-stretch'?: GlassNumberAttribute | null
  /** 液体迁移的回弹，0–1。缺省来自全局默认参数。 */
  'data-glass-morph-bounce'?: GlassNumberAttribute | null
  /** 液体迁移的晃动，0–1。缺省来自全局默认参数。 */
  'data-glass-morph-wobble'?: GlassNumberAttribute | null
  /** 生效与移除的过渡，只对画布渲染有效。`none` 关闭，其他值或不写都是开启。 */
  'data-glass-materialize'?: 'none' | 'auto' | GlassPresenceAttribute | null
  /** 加在普通祖先上：后代玻璃和阴影限制在它的矩形内。 */
  'data-glass-clip'?: GlassPresenceAttribute | null
  /** 模态层根节点。打开时模态层外的玻璃按遮罩透明度压暗。 */
  'data-glass-modal'?: GlassPresenceAttribute | null
  /** 模态层内的遮罩，压暗强度取其背景色 alpha 乘以模态层的 opacity。 */
  'data-glass-scrim'?: GlassPresenceAttribute | null
  /** 页面切换容器，其 opacity 作用到内部玻璃。 */
  'data-glass-fade'?: GlassPresenceAttribute | null
  /** 单独上传的透明前景层。值是一个玻璃层级：盖住更低各层的玻璃；不写值时位于所有玻璃之上。 */
  'data-stage-overlay'?: GlassNumberAttribute | GlassPresenceAttribute | null
}
