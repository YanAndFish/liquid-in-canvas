import { afterEach, describe, expect, it } from 'vitest'
import { compareHtmlPaintOrder } from '@/stage/liquid-glass/content-order'

/** 建立指定 CSS 层级的容器及玻璃内容。 */
function container(z?: number, parent = document.body): HTMLElement {
  const wrapper = document.createElement('div')
  if (z !== undefined) {
    wrapper.style.position = 'relative'
    wrapper.style.zIndex = String(z)
  }
  const glass = document.createElement('button')
  wrapper.append(glass)
  parent.append(wrapper)
  return glass
}

afterEach(() => document.body.replaceChildren())

describe('hTML 内容前后顺序', () => {
  it('较高 z-index 的顶栏覆盖后出现的页面控件', () => {
    const header = container(40)
    const control = container()
    expect(compareHtmlPaintOrder(header, control)).toBeGreaterThan(0)
  })
  it('同一层叠上下文中后出现的控件覆盖前面的控件', () => {
    const first = container()
    const second = container()
    expect(compareHtmlPaintOrder(first, second)).toBeLessThan(0)
  })
  it('子元素的高 z-index 受祖先上下文限制', () => {
    const header = container(40)
    const page = container(0)
    const child = container(100, page)
    expect(compareHtmlPaintOrder(child, header)).toBeLessThan(0)
  })
})
