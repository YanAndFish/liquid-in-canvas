import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHtmlPaintOrderComparator } from '../../src/liquid-glass/content-order'

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

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('hTML 内容前后顺序', () => {
  it('较高 z-index 的顶栏覆盖后出现的页面控件', () => {
    const header = container(40)
    const control = container()
    expect(createHtmlPaintOrderComparator()(header, control)).toBeGreaterThan(0)
  })
  it('分支层级相同时按 DOM 顺序排列控件', () => {
    const first = container(10)
    const second = container(10)
    expect(createHtmlPaintOrderComparator()(first, second)).toBeLessThan(0)
  })
  it('从分支首个 z-index 为零的上下文确定子控件的顺序', () => {
    const header = container(40)
    const page = container(0)
    const child = container(100, page)
    const readStyle = vi.spyOn(globalThis, 'getComputedStyle')

    const sorted = [header, child].sort(createHtmlPaintOrderComparator())

    const styled = readStyle.mock.calls.map(([element]) => element)
    expect(sorted[0]).toBe(child)
    expect(styled).toContain(page.parentElement)
    expect(styled).not.toContain(child.parentElement)
    expect(styled).not.toContain(child)
  })
  it('排序时跳过共同祖先的样式', () => {
    const shared = document.createElement('div')
    shared.style.position = 'relative'
    shared.style.zIndex = '80'
    document.body.append(shared)
    const first = container(undefined, shared)
    const second = container(undefined, shared)
    const third = container(undefined, shared)
    const readStyle = vi.spyOn(globalThis, 'getComputedStyle')

    const sorted = [third, first, second].sort(createHtmlPaintOrderComparator())

    const styled = readStyle.mock.calls.map(([element]) => element)
    expect(sorted[0]).toBe(first)
    expect(sorted[1]).toBe(second)
    expect(sorted[2]).toBe(third)
    expect(styled).not.toContain(shared)
    expect(styled).not.toContain(document.body)
  })
  it('负 z-index 的子控件排在祖先前面', () => {
    const parent = container(50)
    const child = container(-5, parent)

    expect([parent, child].sort(createHtmlPaintOrderComparator())[0]).toBe(child)
  })
  it('祖先的 z-index 改变后，下一次排序使用新的顺序', () => {
    const header = container(40)
    const parent = document.createElement('div')
    parent.style.position = 'relative'
    parent.style.zIndex = '0'
    document.body.append(parent)
    const control = container(undefined, parent)
    const elements = [header, control]

    expect(elements.sort(createHtmlPaintOrderComparator())[0]).toBe(control)
    parent.style.zIndex = '50'
    expect(elements.sort(createHtmlPaintOrderComparator())[0]).toBe(header)
  })
  it('控件移到另一个祖先下后，下一次排序使用新的顺序', () => {
    const back = container(-10)
    const middle = container(40)
    const front = container(50)
    const moving = document.createElement('div')
    front.append(moving)
    const elements = [moving, middle]

    expect(elements.sort(createHtmlPaintOrderComparator())[0]).toBe(middle)
    back.append(moving)
    expect(elements.sort(createHtmlPaintOrderComparator())[0]).toBe(moving)
  })
})
