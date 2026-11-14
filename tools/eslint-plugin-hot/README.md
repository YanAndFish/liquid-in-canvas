# eslint-plugin-hot

`*.hot.ts` 是热路径文件：里面的函数每帧都可能执行。这个插件检查这些函数有没有分配堆内存，避免滚动和动画期间频繁触发 GC。

## 规则

| 规则 | 检查内容 |
| --- | --- |
| `hot/no-alloc` | `new`、对象与数组字面量、展开、数组解构与剩余参数、带插值的模板字符串、正则字面量、字符串拼接、`async` 函数，以及按名称识别的分配方法（`map`、`filter`、`slice`、`sort`、`values`、`split`、`toFixed`、`then` 等，完整列表见 `rules/no-alloc.js`） |
| `hot/no-closure` | 在函数里创建函数：箭头函数、函数表达式、嵌套的函数声明，包括传给 `forEach` 等方法的回调 |

只执行一次的位置不检查：模块顶层、构造函数、类字段初始值、静态初始化块，以及 `throw` 语句的参数。

`sort` 也在禁止之列：V8 的 `Array.prototype.sort` 每次都会分配工作数组。热路径里用插入排序。

## 写热路径代码

- 对象池、描述对象、类型化数组在构造函数里创建，每帧改写字段。
- 需要分配的事情（对象池第一次扩容、缓存未命中、纹理尺寸变化）写在普通 `.ts` 文件里，作为冷路径函数，热路径只在这些少见情况下调用。规则不跟进调用，冷路径函数的快速路径要保证不分配。
- DOM 接口（`getBoundingClientRect()`、`getComputedStyle()`、`getClientRects()`）返回的新对象无法静态识别，也不会被规则报告。这些对象由 Blink 的堆管理，只在老生代 GC 时回收。同一元素在一帧内只读一次，能用 `checkVisibility()` 这类返回原始值的接口就不用前者。
- 确实需要例外时用 `// eslint-disable-next-line hot/no-alloc -- 原因`。热路径文件要求写明原因（`eslint-comments/require-description`）。

## 测试

```sh
pnpm --filter @liquid-in-canvas/eslint-plugin-hot test
```
