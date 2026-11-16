export const ATTR_OFF = 'false'

/** 声明一块液态玻璃。参数使用 `data-glass-*`，见 `liquid-glass/options.ts`。 */
export const GLASS_ATTR = 'data-liquid-glass'

/** 普通祖先：后代玻璃与阴影限制在它的矩形内。 */
export const GLASS_CLIP_ATTR = 'data-glass-clip'

/** 模态层根节点。存在时按遮罩透明度压暗模态层外的玻璃。 */
export const GLASS_MODAL_ATTR = 'data-glass-modal'

/** 模态层内的遮罩，压暗强度取其背景色 alpha 乘以模态层 opacity。 */
export const GLASS_SCRIM_ATTR = 'data-glass-scrim'

/**
 * 玻璃参数作用域：元素上的 `data-glass-*` 参数作为后代玻璃的缺省值，就近的作用域优先，
 * 玻璃自身的属性又优先于作用域。可以用在 `display: contents` 的包装元素上，不影响布局。
 * @since 0.3.0
 */
export const GLASS_SCOPE_ATTR = 'data-glass-scope'

/**
 * 玻璃里的元素画在玻璃之上还是之下：`below` 时这个元素不进玻璃的内容快照，改为画在玻璃下面，
 * 和背景一起被这块玻璃折射与模糊；`above` 或不写时照常画在玻璃之上。只对画布渲染有效。
 * @since 0.4.0
 */
export const GLASS_PLACE_ATTR = 'data-glass-place'

/** 页面切换容器，其 opacity 作用到内部玻璃的内容与体积。 */
export const GLASS_FADE_ATTR = 'data-glass-fade'

/**
 * 舞台单独上传的透明前景层。属性值是一个玻璃层级：前景层盖住更低各层的玻璃，
 * 又被该层及更高层的玻璃盖住；不写值时位于所有玻璃之上。
 */
export const STAGE_OVERLAY_ATTR = 'data-stage-overlay'

/** 把属性名转成属性选择器，值为 `"false"` 的属性不匹配。 */
export function attr(name: string): string {
  return `[${name}]:not([${name}="${ATTR_OFF}"])`
}

/**
 * 元素是否声明了某个约定属性，值为 `"false"` 时视为未声明。
 * @since 0.3.0
 */
export function hasAttr(element: Element, name: string): boolean {
  const value = element.getAttribute(name)
  return value !== null && value !== ATTR_OFF
}
