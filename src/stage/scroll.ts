export const STAGE_SCROLL_ID = 'stage-scroll'

export function getStageScroller(): HTMLElement | null {
  if (typeof document === 'undefined')
    return null
  return document.getElementById(STAGE_SCROLL_ID)
}

export function setStageScrollLocked(locked: boolean): void {
  getStageScroller()?.classList.toggle('is-locked', locked)
}
