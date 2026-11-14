/**
 * 与渲染无关的动效工具：玻璃按压使用的阻尼弹簧与“减少动态效果”查询。
 * 页面自己的菜单动画使用同一套弹簧，手感才会和玻璃形变一致。
 */
export { prefersReducedMotion, REDUCED_MOTION_QUERY, reducedMotionQuery } from './shared/motion'
export { advanceSpring } from './shared/spring.hot'
export type { SpringState } from './shared/spring.hot'
