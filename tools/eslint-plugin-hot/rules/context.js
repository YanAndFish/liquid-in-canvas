export function onceContext(node, sourceCode) {
  const ancestors = sourceCode.getAncestors(node)
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i]
    const child = ancestors[i + 1] ?? node
    switch (ancestor.type) {
      case 'ThrowStatement':
        return 'throw'
      case 'StaticBlock':
        return 'static'
      case 'PropertyDefinition':
        if (ancestor.value === child)
          return 'field'
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return isConstructor(ancestor)
          ? 'constructor'
          : null
    }
  }
  return 'module'
}

export function isConstructor(fn) {
  return fn.type === 'FunctionExpression'
    && fn.parent?.type === 'MethodDefinition'
    && fn.parent.kind === 'constructor'
}

export const DOCS_URL = 'https://github.com/YanAndFish/liquid-in-canvas/tree/main/tools/eslint-plugin-hot#readme'
