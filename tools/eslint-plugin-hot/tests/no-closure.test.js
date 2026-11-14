import rule from '../rules/no-closure.js'
import { createTester } from './setup.js'

createTester().run('no-closure', rule, {
  valid: [
    'function top() {} const g = () => 1; export default function () {}',
    'class A { method() {} get x() { return 1 } set x(v) {} static make() {} }',
    'class A { handle = () => this.run(); constructor() { this.cb = () => 1 } }',
    'const table = { make() { return 1 } }',
    'function f(list) { for (let i = 0; i < list.length; i++) list[i].run() }',
  ],
  invalid: [
    {
      code: 'function f(list) { list.forEach(item => item.run()) }',
      errors: [
        { messageId: 'closure' },
      ],
    },
    {
      code: 'class A { draw(list) { return list.some(function (x) { return x }) } }',
      errors: [
        { messageId: 'closure' },
      ],
    },
    {
      code: 'function f() { function inner() {} return inner }',
      errors: [
        { messageId: 'closure' },
      ],
    },
    {
      code: 'class A { constructor() { this.cb = () => () => 1 } }',
      errors: [
        { messageId: 'closure' },
      ],
    },
  ],
})
