/**
 * 画布遍的绘制顺序。绘制项按顺序值从小到大绘制，值越大越靠前。
 *
 * | 顺序                    | 内容                                            |
 * | ----------------------- | ----------------------------------------------- |
 * | 0                       | 页面快照（全屏三角形）                          |
 * | 900 + 10·L − 0.5        | 声明在第 L 层的前景层                           |
 * | 900 + 10·L … +0.5       | 第 L 层玻璃的三维体积组                         |
 * | 900 + 10·L + 1 … +2     | 第 L 层玻璃上的 HTML 内容，按 HTML 绘制顺序排列 |
 *
 * 前景层因此盖住更低各层的玻璃与内容，又被同层及更高层的玻璃盖住。
 */

export const PAGE_RENDER_ORDER = 0

/** 玻璃层级的取值范围，见 `data-glass-layer`。 */
export const GLASS_LAYER_RANGE = [-100, 100] as const

/** 没有声明层级的前景层使用的层级，高于所有玻璃。 */
export const OVERLAY_TOP_LAYER = GLASS_LAYER_RANGE[1] + 1

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

/** 前景层的顺序：在第 layer 层玻璃之下、更低各层的内容之上。 */
export function overlayRenderOrder(layer: number): number {
  return glassRenderOrder(layer) - 0.5
}
