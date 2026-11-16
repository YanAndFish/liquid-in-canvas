import { DOCS_URL, onceContext } from './context.js'

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
