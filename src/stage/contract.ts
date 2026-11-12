/**
 * 页面与渲染舞台之间的 DOM 约定。
 *
 * Vue 组件用这些 ID 和属性声明自己在舞台中的角色；舞台只认这些钩子，
 * 不依赖具体组件的类名或 ID。新增约定时在此登记，并同步 docs/ARCHITECTURE.md。
 */

/** 舞台内唯一的滚动容器。`src/styles/main.css` 中的 `#stage-scroll` 规则与此对应。 */
export const STAGE_SCROLL_ID = 'stage-scroll'

/** 声明一块液态玻璃。参数使用 `data-glass-*`，见 `liquid-glass/options.ts`。 */
export const GLASS_ATTR = 'data-liquid-glass'

/** 普通祖先：后代玻璃与阴影限制在它的矩形内。 */
export const GLASS_CLIP_ATTR = 'data-glass-clip'

/** 模态层根节点。存在时按遮罩透明度压暗模态层外的玻璃。 */
export const GLASS_MODAL_ATTR = 'data-glass-modal'

/** 模态层内的遮罩，压暗强度取其背景色 alpha 乘以模态层 opacity。 */
export const GLASS_SCRIM_ATTR = 'data-glass-scrim'

/** 页面切换容器，其 opacity 作用到内部玻璃的内容与体积。 */
export const GLASS_FADE_ATTR = 'data-glass-fade'

/** 舞台单独上传、绘制在导航玻璃之上的透明前景层。 */
export const STAGE_OVERLAY_ATTR = 'data-stage-overlay'

/** 把属性名转成属性选择器。 */
export function attr(name: string): string {
  return `[${name}]`
}

/** 返回舞台滚动容器；非浏览器环境或尚未挂载时为 null。 */
export function getStageScroller(): HTMLElement | null {
  if (typeof document === 'undefined')
    return null
  return document.getElementById(STAGE_SCROLL_ID)
}

/** 打开模态层时锁定页面滚动。 */
export function setStageScrollLocked(locked: boolean): void {
  getStageScroller()?.classList.toggle('is-locked', locked)
}
