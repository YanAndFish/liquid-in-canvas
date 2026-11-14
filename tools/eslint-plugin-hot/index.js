import noAlloc from './rules/no-alloc.js'
import noClosure from './rules/no-closure.js'

/**
 * 热路径规则：`*.hot.ts` 里每帧执行的函数不得分配堆内存，避免频繁 GC 打断动画。
 * 说明见同目录的 README。
 */
export default {
  meta: {
    name: '@liquid-in-canvas/eslint-plugin-hot',
    version: '0.1.0',
  },
  rules: {
    'no-alloc': noAlloc,
    'no-closure': noClosure,
  },
}
