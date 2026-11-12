/**
 * 舞台场景的绘制顺序。three.js 按 renderOrder 从小到大绘制，值越大越靠前。
 *
 * | 区间                    | 内容                                           |
 * | ----------------------- | ---------------------------------------------- |
 * | 0                       | 页面快照（全屏三角形）                         |
 * | 900 + 10·L … +0.5       | 第 L 层玻璃的三维体积组                        |
 * | 900 + 10·L + 1 … +2     | 第 L 层玻璃上的 HTML 内容，按 HTML 绘制顺序排列 |
 * | 950                     | 共享商品动画前景（位于 0–4 层之上、5 层之下）   |
 *
 * 购物袋使用第 10 层，因此商品动画位于导航玻璃之上、购物袋之下。
 */

export const PAGE_RENDER_ORDER = 0

export const OVERLAY_RENDER_ORDER = 950

/** 将玻璃层级映射到场景顺序，每层留出体积与内容的位置。 */
export function glassRenderOrder(layer: number): number {
  return 900 + layer * 10
}

/** 体积组的顺序。paintOrder 为同层内归一化到 0–1 的 HTML 绘制顺序。 */
export function glassVolumeRenderOrder(layer: number, paintOrder: number): number {
  return glassRenderOrder(layer) + paintOrder * 0.5
}

/** 玻璃上 HTML 内容的顺序，总在同层体积组之上。 */
export function glassContentRenderOrder(layer: number, paintOrder: number): number {
  return glassRenderOrder(layer) + 1 + paintOrder
}
