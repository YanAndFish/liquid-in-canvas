/**
 * 页面上 `data-*` 属性的类型，只有类型，没有运行时代码。
 *
 * 属性在运行时都按字符串读取（见 `liquid-glass/options.ts` 与 `contract.ts`），这里给出各属性接受的写法，
 * 供 JSX 或模板做补全和检查。框架的属性类型扩展见 `liquid-in-canvas/vue` 与 `liquid-in-canvas/react`；
 * 其他场景可以直接使用 `LiquidGlassAttributes`，例如给自己的组件属性加上这些键。
 *
 * 数值超出范围时被限制在范围之内，无法解析时取全局默认值，见 `GLASS_LIMITS` 与 `setGlassDefaults()`。
 * 玻璃参数（`data-glass-*`）也可以写在带 `data-glass-scope` 的祖先上，作为其中所有玻璃的缺省值。
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
 * 开关属性：写成空字符串，或在 JSX、Vue 模板里不写值表示打开。
 * `false`（框架渲染成字符串 `"false"`）、`undefined` 与 `null` 都表示关闭，可以直接绑定布尔值。
 * 布尔值写法自 0.3.0 起支持；更早的版本里 `"false"` 仍然表示打开。
 */
export type GlassPresenceAttribute = '' | boolean | 'true' | 'false'

/** 声明液态玻璃及其参数的属性。长度单位都是 CSS 像素，缺省一栏写作 `regular / clear`。 */
export interface LiquidGlassAttributes {
  /** 声明一块液态玻璃。 */
  'data-liquid-glass'?: GlassPresenceAttribute | null
  /** 材质：`regular` 使用较强模糊与主题染色，`clear` 保留更多背景细节，决定其他材质参数的缺省值。缺省 `regular`。 */
  'data-glass-variant'?: 'regular' | 'clear' | null
  /** 圆角，0–2000。缺省 28。 */
  'data-glass-radius'?: GlassRadiusAttribute | null
  /** 背景高斯模糊的标准差，0–80。缺省 18 / 0。 */
  'data-glass-blur'?: GlassNumberAttribute | null
  /** 三维实体的半厚度上限，0–80。实际厚度为短边的 0.3 倍，不超过这个值。缺省 80。 */
  'data-glass-refraction'?: GlassNumberAttribute | null
  /** 边缘倒角的水平宽度，按半厚度的倍数，0.1–4。缺省 0.8。 */
  'data-glass-bevel-width'?: GlassNumberAttribute | null
  /** 边缘倒角的垂直高度，按半厚度的倍数，0.05–1；1 表示侧面没有竖直部分。缺省 1。 */
  'data-glass-bevel-height'?: GlassNumberAttribute | null
  /** 倒角曲线的超椭圆指数，1–8：1 是直线斜面，2 是椭圆弧，越大越接近直角。缺省 2.75。 */
  'data-glass-bevel-curve'?: GlassNumberAttribute | null
  /** 底面倒角相对顶面倒角的比例，0–1；0 表示底面是带直角边的平面。缺省 1。 */
  'data-glass-bottom-bevel'?: GlassNumberAttribute | null
  /** RGB 取样分离强度，0–1。缺省 0.05。 */
  'data-glass-dispersion'?: GlassNumberAttribute | null
  /**
   * 折射率，1–2.5：1 表示不偏折，水约 1.33，玻璃约 1.5。越大边缘的扭曲越强，全反射的暗边也越宽。缺省 1.45。
   * @since 0.4.0
   */
  'data-glass-ior'?: GlassNumberAttribute | null
  /** 凸透镜强度，0–0.6，只对画布渲染有效。缺省 0。 */
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
  /**
   * 液体迁移，只对画布渲染有效。空值或 `true` 表示自身位置或尺寸变化时流动过去，其他值同时是迁移的名字。
   * `false` 与不写都是关闭。不从 `data-glass-scope` 继承。
   * 0.3.0 起 `true` / `false` 才是开关，更早的版本把它们当作迁移的名字。
   */
  'data-glass-morph'?: string | boolean | null
  /**
   * 出现时从哪块玻璃里分出来，只对画布渲染有效。值是空格分隔的 `data-glass-morph` 名字，按顺序取第一块在场的；
   * 名字先在最近的 `data-glass-scope` 里查找，再到外层。没有声明时取 `data-glass-morph-to`；两者都没有时只做同名交接。
   * 声明后即使没有 `data-glass-morph` 也打开液体迁移。不从 `data-glass-scope` 继承。
   * @since 0.5.0
   */
  'data-glass-morph-from'?: string | null
  /**
   * 消失时并入哪块玻璃，只对画布渲染有效。值的写法与查找规则同 `data-glass-morph-from`；没有声明时取 `data-glass-morph-from`。
   * 不从 `data-glass-scope` 继承。
   * @since 0.5.0
   */
  'data-glass-morph-to'?: string | null
  /** 液体迁移的拉伸，0–2。缺省来自全局默认参数。 */
  'data-glass-morph-stretch'?: GlassNumberAttribute | null
  /** 液体迁移的回弹，0–1。缺省来自全局默认参数。 */
  'data-glass-morph-bounce'?: GlassNumberAttribute | null
  /** 液体迁移的晃动，0–1。缺省来自全局默认参数。 */
  'data-glass-morph-wobble'?: GlassNumberAttribute | null
  /**
   * 液体迁移期间玻璃上的内容，只对画布渲染有效。`static` 停在元素位置（尺寸过渡时随玻璃展开显露）；
   * `clip` 停在元素位置并裁剪在体积之内，相当于 `overflow: hidden`；`follow` 随体积一起拉伸、回弹和晃动。缺省 `static`。
   * @since 0.3.0
   */
  'data-glass-morph-content'?: 'static' | 'clip' | 'follow' | null
  /** 生效与移除的过渡，只对画布渲染有效。`none` 或 `false` 关闭，其他值或不写都是开启。 */
  'data-glass-materialize'?: 'none' | 'auto' | GlassPresenceAttribute | null
  /**
   * 玻璃参数作用域：这个元素上的 `data-glass-*` 参数成为其中所有玻璃的缺省值，就近的作用域优先，
   * 玻璃自身的属性又优先于作用域。可以配合 `display: contents` 作为不占布局的包装元素。
   * @since 0.3.0
   */
  'data-glass-scope'?: GlassPresenceAttribute | null
  /** 加在普通祖先上：后代玻璃和阴影限制在它的矩形内。 */
  'data-glass-clip'?: GlassPresenceAttribute | null
  /** 模态层根节点。打开时模态层外的玻璃按遮罩透明度压暗。 */
  'data-glass-modal'?: GlassPresenceAttribute | null
  /** 模态层内的遮罩，压暗强度取其背景色 alpha 乘以模态层的 opacity。 */
  'data-glass-scrim'?: GlassPresenceAttribute | null
  /**
   * 写在玻璃里的元素上：`below` 时它画在玻璃之下，和背景一起被这块玻璃折射与模糊；`above` 或不写时画在玻璃之上。
   * 只对画布渲染有效。
   * @since 0.4.0
   */
  'data-glass-place'?: 'above' | 'below' | null
  /** 页面切换容器，其 opacity 作用到内部玻璃。 */
  'data-glass-fade'?: GlassPresenceAttribute | null
  /** 单独上传的透明前景层。值是一个玻璃层级：盖住更低各层的玻璃；不写值时位于所有玻璃之上。 */
  'data-stage-overlay'?: GlassNumberAttribute | GlassPresenceAttribute | null
}
