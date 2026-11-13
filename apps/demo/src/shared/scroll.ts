/** 舞台内唯一的滚动容器。`src/styles/main.css` 中的 `#stage-scroll` 规则与此对应。 */
export const STAGE_SCROLL_ID = 'stage-scroll'

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
