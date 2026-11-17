import type { LiquidGlassAttributes } from './attributes'
import { GLASS_ATTR } from './contract'
import { GLASS_OPTION_ATTRS } from './liquid-glass/options'

type Camel<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : S

type GlassOptionAttribute = (typeof GLASS_OPTION_ATTRS)[number]

type OptionName<A extends string> = A extends `data-glass-${infer Name}`
  ? Camel<Name>
  : never

/**
 * `addGlass()` 接受的玻璃参数：`data-glass-*` 属性去掉前缀、改成驼峰写法，取值与属性相同。
 * `null` 移除这个参数，回到作用域或全局默认值；不写的键保持不变。
 * @since 0.4.0
 */
export type GlassAttributeOptions = {
  [A in GlassOptionAttribute as OptionName<A>]?: LiquidGlassAttributes[A]
}

/**
 * `addGlass()` 返回的句柄。
 * @since 0.4.0
 */
export interface GlassHandle {
  /** 声明为玻璃的元素。 */
  readonly element: HTMLElement
  /** 修改参数，规则与 `addGlass()` 的 `options` 相同。玻璃已经移除时不做任何事。 */
  update: (options: GlassAttributeOptions) => void
  /** 移除这块玻璃，等同于 `removeGlass(element)`。 */
  remove: () => void
}

const ATTRIBUTE_OF = new Map<string, string>(GLASS_OPTION_ATTRS.map(name => [
  name.slice('data-glass-'.length).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
  name,
]))

const written = new WeakMap<Element, Set<string>>()

function apply(element: HTMLElement, options: GlassAttributeOptions): void {
  const names = written.get(element) ?? new Set<string>()
  written.set(element, names)
  for (const [key, value] of Object.entries(options)) {
    const name = ATTRIBUTE_OF.get(key)
    if (name === undefined)
      throw new TypeError(`Unknown glass option: ${key}`)
    if (value === undefined)
      continue
    if (value === null) {
      element.removeAttribute(name)
      names.delete(name)
      continue
    }
    element.setAttribute(name, value === true
      ? ''
      : String(value))
    names.add(name)
  }
}

export function addGlass(root: HTMLElement, element: HTMLElement, options: GlassAttributeOptions = {}): GlassHandle {
  if (!root.contains(element))
    throw new Error('addGlass: the element must be inside the mounted root')
  apply(element, options)
  element.setAttribute(GLASS_ATTR, '')
  return {
    element,
    update(next) {
      if (element.hasAttribute(GLASS_ATTR))
        apply(element, next)
    },
    remove() {
      removeGlass(element)
    },
  }
}

export function removeGlass(element: HTMLElement): void {
  element.removeAttribute(GLASS_ATTR)
  const names = written.get(element)
  if (!names)
    return
  for (const name of names)
    element.removeAttribute(name)
  written.delete(element)
}
