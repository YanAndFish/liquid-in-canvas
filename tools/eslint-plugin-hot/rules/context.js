/**
 * 判断一个节点所在的代码会执行多少次。
 *
 * 热路径文件里的函数默认每帧都会执行。下面几处只执行一次或只在出错时执行，允许分配：
 *
 * - `module`：模块顶层，例如常量表、着色器源码。
 * - `constructor`：构造函数体与参数。对象池、预先分配的描述对象放在这里。
 * - `field`：类字段的初始值，每个实例只求值一次。
 * - `static`：类的静态初始化块。
 * - `throw`：`throw` 语句的参数，只在出错时执行。
 *
 * 返回 null 表示节点位于普通函数中，每次调用都会执行。
 *
 * @param {import('eslint').Rule.Node} node
 * @param {import('eslint').SourceCode} sourceCode
 * @returns {'module' | 'constructor' | 'field' | 'static' | 'throw' | null} 节点所在的执行位置
 */
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

/** 函数是否是类的构造函数。 */
export function isConstructor(fn) {
  return fn.type === 'FunctionExpression'
    && fn.parent?.type === 'MethodDefinition'
    && fn.parent.kind === 'constructor'
}

/** 规则文档的链接，指向插件的说明。 */
export const DOCS_URL = 'https://github.com/YanAndFish/liquid-in-canvas/tree/main/tools/eslint-plugin-hot#readme'
