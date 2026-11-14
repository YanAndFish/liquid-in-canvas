/* eslint-disable no-template-curly-in-string -- 用例是含模板字符串的源码文本 */
import rule from '../rules/no-alloc.js'
import { createTester } from './setup.js'

createTester().run('no-alloc', rule, {
  valid: [
    // 模块顶层只执行一次。
    'const TABLE = { a: [1, 2, 3] }; const RE = /x/g; const s = `${TABLE}`; new Map()',
    // 构造函数与类字段只在创建实例时执行。
    'class A { pool = []; scratch = { x: 0 }; constructor(...args) { this.list = new Array(4); this.o = { ...args } } }',
    'class A { static { const x = [1] } }',
    // 出错路径。
    'function f(x) { if (!x) throw new Error(`bad ${x}`) }',
    // 不分配的写法。
    'function f(data, items) { let sum = 0; for (let i = 0; i < items.length; i++) sum += items[i].value; data[0] = sum; data.set(items[0].clip, 4); return Math.max(sum, 1) }',
    'function f(list) { for (const item of list) item.count++ }',
    'function f(a) { const { x, y } = a; return x + y }',
    'function f(map, key) { return map.get(key) ?? fallback(key) }',
    'function f(s) { return s.label === "canvas" ? 1 : 0 }',
    // 带标签的模板交给标签函数处理。
    'function f(x) { return wgsl`${x}` }',
    // 类型断言不会分配。
    'function f(x) { return (x as unknown as number) + 1 }',
  ],
  invalid: [
    {
      code: 'function f() { return new Float32Array(4) }',
      errors: [
        { messageId: 'new' },
      ],
    },
    {
      code: 'class A { draw() { this.m = new DOMMatrix() } }',
      errors: [
        { messageId: 'new' },
      ],
    },
    {
      code: 'function f() { return { x: 1 } }',
      errors: [
        { messageId: 'object' },
      ],
    },
    {
      code: 'function f(a) { return [a, a] }',
      errors: [
        { messageId: 'array' },
      ],
    },
    {
      code: 'function f(a) { return Math.max(...a) }',
      errors: [
        { messageId: 'spread' },
      ],
    },
    {
      code: 'function f(a) { const [x] = a; return x }',
      errors: [
        { messageId: 'pattern' },
      ],
    },
    {
      code: 'function f(...a) { return a.length }',
      errors: [
        { messageId: 'rest' },
      ],
    },
    {
      code: 'function f(o) { const { a, ...rest } = o; return rest }',
      errors: [
        { messageId: 'rest' },
      ],
    },
    {
      code: 'function f(n) { return `volume:${n}` }',
      errors: [
        { messageId: 'template' },
      ],
    },
    {
      code: 'function f(s) { return /x/.test(s) }',
      errors: [
        { messageId: 'regex' },
      ],
    },
    {
      code: 'function f(n) { return "key" + n }',
      errors: [
        { messageId: 'concat' },
      ],
    },
    {
      code: 'function f(s) { s += "x"; return s }',
      errors: [
        { messageId: 'concat' },
      ],
    },
    {
      code: 'async function f() {}',
      errors: [
        { messageId: 'async' },
      ],
    },
    {
      code: 'function f(list) { return list.slice(1) }',
      errors: [
        {
          messageId: 'method',
          data: { name: 'slice' },
        },
      ],
    },
    {
      code: 'function f(list) { list.sort(compare) }',
      errors: [
        {
          messageId: 'method',
          data: { name: 'sort' },
        },
      ],
    },
    {
      code: 'function f(map) { for (const v of map.values()) use(v) }',
      errors: [
        {
          messageId: 'method',
          data: { name: 'values' },
        },
      ],
    },
    {
      code: 'function f(x) { return x?.toFixed(1) }',
      errors: [
        {
          messageId: 'method',
          data: { name: 'toFixed' },
        },
      ],
    },
    {
      code: 'function f(x) { return String(x) }',
      errors: [
        {
          messageId: 'global',
          data: { name: 'String' },
        },
      ],
    },
    // 构造函数里定义的函数，函数体仍然是热路径。
    {
      code: 'class A { constructor() { this.run = () => ({ x: 1 }) } }',
      errors: [
        { messageId: 'object' },
      ],
    },
    // 类字段里的箭头函数只创建一次，但每次调用都会执行函数体。
    {
      code: 'class A { handle = () => { use([1]) } }',
      errors: [
        { messageId: 'array' },
      ],
    },
  ],
})
