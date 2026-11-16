import noAlloc from './rules/no-alloc.js'
import noClosure from './rules/no-closure.js'

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
