import { DOCS_URL, onceContext } from './context.js'

/**
 * 返回新对象、新数组、新字符串、迭代器或 Promise 的方法。按名称匹配，不区分接收者的类型，
 * 因此热路径代码里的自定义方法不要使用这些名字。
 */
const ALLOCATING_METHODS = new Set([
  // 数组与迭代器
  'concat',
  'entries',
  'filter',
  'flat',
  'flatMap',
  'from',
  'keys',
  'map',
  'of',
  'slice',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'values',
  'with',
  // 字符串
  'join',
  'match',
  'matchAll',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'split',
  'substr',
  'substring',
  'toFixed',
  'toLowerCase',
  'toPrecision',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
  // 函数、Promise 与序列化
  'bind',
  'catch',
  'finally',
  'fromEntries',
  'parse',
  'stringify',
  'then',
])

/** 直接调用就会分配的全局函数。 */
const ALLOCATING_GLOBALS = new Set([
  'Array',
  'Object',
  'String',
  'Symbol',
  'structuredClone',
])

function propertyName(member) {
  if (!member.computed && member.property.type === 'Identifier')
    return member.property.name
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string')
    return member.property.value
  return null
}

function isString(node) {
  return (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral'
}

/**
 * 禁止在热路径函数里分配堆内存。
 *
 * 检查 `new`、对象与数组字面量、展开、数组解构与剩余参数、带插值的模板字符串、
 * 正则字面量、字符串拼接、`async` 函数，以及按名称识别的分配方法（见 `ALLOCATING_METHODS`）。
 * 构造函数、类字段初始值、模块顶层与 `throw` 语句不检查，见 `onceContext()`。
 *
 * DOM 接口（`getBoundingClientRect()`、`getComputedStyle()` 等）返回的新对象无法静态识别，不在检查范围内。
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止在每帧执行的函数里分配堆内存',
      url: DOCS_URL,
    },
    schema: [],
    messages: {
      new: '热路径函数里的 new 每次都会分配对象。在构造函数里预先创建并复用，或移到冷路径。',
      object: '对象字面量每次求值都会分配对象。复用预先创建的对象，或直接写入字段。',
      array: '数组字面量每次求值都会分配数组。复用预先创建的数组或类型化数组。',
      spread: '展开参数会分配临时数组。改为逐个传参或循环。',
      pattern: '数组解构经过迭代器协议，会分配迭代器与结果对象。改为按下标读取。',
      rest: '剩余参数或剩余属性每次调用都会分配新的数组或对象。',
      template: '带插值的模板字符串每次都会分配新字符串。预先算好，或改用数字键。',
      regex: '正则字面量每次求值都会创建新的 RegExp。移到模块顶层。',
      concat: '字符串拼接会分配新字符串。预先算好，或改用数字键。',
      async: 'async 函数每次调用都会分配 Promise。',
      method: '`{{name}}()` 会分配新的数组、字符串、迭代器或 Promise。改用循环或预先分配的缓冲。',
      global: '`{{name}}()` 会分配新对象。',
    },
  },
  create(context) {
    const { sourceCode } = context
    function report(node, messageId, data) {
      if (onceContext(node, sourceCode) === null)
        context.report({ node, messageId, data })
    }
    function checkFunction(node) {
      // 函数本身每次调用都会返回 Promise；参数与函数体的位置以这个函数为准。
      if (node.async && !(node.parent?.type === 'MethodDefinition' && node.parent.kind === 'constructor'))
        context.report({ node, messageId: 'async' })
    }
    return {
      NewExpression(node) {
        report(node, 'new')
      },
      ObjectExpression(node) {
        report(node, 'object')
      },
      ArrayExpression(node) {
        report(node, 'array')
      },
      SpreadElement(node) {
        // 字面量里的展开已经随字面量报告。
        if (node.parent.type === 'CallExpression' || node.parent.type === 'NewExpression')
          report(node, 'spread')
      },
      ArrayPattern(node) {
        report(node, 'pattern')
      },
      RestElement(node) {
        report(node, 'rest')
      },
      TemplateLiteral(node) {
        if (node.expressions.length > 0 && node.parent.type !== 'TaggedTemplateExpression')
          report(node, 'template')
      },
      Literal(node) {
        if (node.regex)
          report(node, 'regex')
      },
      BinaryExpression(node) {
        if (node.operator === '+' && (isString(node.left) || isString(node.right)))
          report(node, 'concat')
      },
      AssignmentExpression(node) {
        if (node.operator === '+=' && isString(node.right))
          report(node, 'concat')
      },
      CallExpression(node) {
        const callee = node.callee.type === 'ChainExpression'
          ? node.callee.expression
          : node.callee
        if (callee.type === 'MemberExpression') {
          const name = propertyName(callee)
          if (name && ALLOCATING_METHODS.has(name))
            report(node, 'method', { name })
        }
        else if (callee.type === 'Identifier' && ALLOCATING_GLOBALS.has(callee.name)) {
          report(node, 'global', { name: callee.name })
        }
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    }
  },
}
