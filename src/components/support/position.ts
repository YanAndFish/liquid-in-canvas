/** 视口内的坐标或尺寸，单位为 CSS 像素。 */
export interface SupportPoint {
  /** 水平位置或宽度。 */
  x: number
  /** 垂直位置或高度。 */
  y: number
}

/** 把客服按钮限制在可见范围内，四周保留 12 像素。 */
export function clampSupportPosition(position: SupportPoint, viewport: SupportPoint, buttonSize: number): SupportPoint {
  return {
    x: Math.max(12, Math.min(position.x, viewport.x - buttonSize - 12)),
    y: Math.max(12, Math.min(position.y, viewport.y - buttonSize - 12)),
  }
}

/** 将对话框放在按钮上方或下方，并限制在视口内。 */
export function supportPanelPosition(button: SupportPoint, viewport: SupportPoint, panel: SupportPoint, buttonSize: number): SupportPoint {
  const above = button.y - panel.y - 12
  const below = button.y + buttonSize + 12
  return {
    x: Math.max(12, Math.min(button.x + buttonSize - panel.x, viewport.x - panel.x - 12)),
    y: Math.max(12, Math.min(above >= 12
      ? above
      : below, viewport.y - panel.y - 12)),
  }
}
