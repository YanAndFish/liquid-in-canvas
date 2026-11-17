import { DOCS_URL, onceContext } from './context.js'

const ALLOCATING_METHODS = new Set([
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
  'bind',
  'catch',
  'finally',
  'fromEntries',
  'parse',
  'stringify',
  'then',
])

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
