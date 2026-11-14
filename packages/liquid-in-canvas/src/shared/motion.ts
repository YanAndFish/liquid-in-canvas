/** 系统“减少动态效果”设置的媒体查询。 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** 返回可监听的减少动态效果查询；环境不支持 matchMedia 时为 null。 */
export function reducedMotionQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function'
    ? matchMedia(REDUCED_MOTION_QUERY)
    : null
}

/** 当前是否要求减少动态效果。 */
export function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false
}
