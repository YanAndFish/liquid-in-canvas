import { DOCS_URL, onceContext } from './context.js'

/**
 * 禁止在热路径函数里创建函数。
 *
 * 函数表达式、箭头函数和嵌套的函数声明每次求值都会分配一个闭包对象，
 * 传给 `forEach`、`sort`、`some` 的回调也是如此。类方法、模块顶层函数，
 * 以及构造函数和类字段里创建的函数只分配一次，不在检查范围内。
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止在每帧执行的函数里创建闭包',
      url: DOCS_URL,
    },
    schema: [],
    messages: {
      closure: '热路径函数里创建的函数每次执行都会分配闭包。改用循环、类方法或在构造函数里预先创建。',
    },
  },
  create(context) {
    const { sourceCode } = context
    function check(node) {
      // 类方法、取值器与存值器定义在类上，只创建一次。
      if (node.parent?.type === 'MethodDefinition' || node.parent?.type === 'TSAbstractMethodDefinition')
        return
      if (onceContext(node, sourceCode) === null)
        context.report({ node, messageId: 'closure' })
    }
    return {
      FunctionExpression: check,
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
    }
  },
}
