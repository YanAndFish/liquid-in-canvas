import type { StageFault } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLASS_CSS_ATTR } from '../src/css/CssGlassStage'
import { mountLiquidGlass, StageUnsupportedError } from '../src/mount'

let root: HTMLElement
let element: HTMLElement

beforeEach(() => {
  root = document.createElement('div')
  element = document.createElement('div')
  element.setAttribute('data-liquid-glass', '')
  root.append(element)
  document.body.append(root)
})

afterEach(() => {
  root.remove()
})

describe('mountLiquidGlass', () => {
  it('auto 模式在不支持的浏览器上使用 CSS 回退并说明原因', async () => {
    const faults: StageFault[] = []
    const beforeStart = vi.fn()
    const mount = await mountLiquidGlass({
      root,
      beforeStart,
      onFault: fault => faults.push(fault),
    })
    expect(mount.mode).toBe('css')
    expect(mount.stage).toBeNull()
    expect(mount.canvas).toBeNull()
    expect(mount.support.supported).toBe(false)
    expect(beforeStart).toHaveBeenCalledWith(root, 'css')
    expect(faults).toHaveLength(1)
    expect(faults[0]!.kind).toBe('unsupported')
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(true)
    expect(root.parentElement).toBe(document.body)
    expect(document.querySelector('canvas')).toBeNull()
    mount.dispose()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
  })

  it('指定 css 模式时不报告故障', async () => {
    const onFault = vi.fn()
    const mount = await mountLiquidGlass({ root, mode: 'css', onFault })
    expect(mount.mode).toBe('css')
    expect(onFault).not.toHaveBeenCalled()
    mount.dispose()
  })

  it('指定 canvas 模式时不做回退，直接抛出不支持的原因', async () => {
    const beforeStart = vi.fn()
    const failure = await mountLiquidGlass({ root, mode: 'canvas', beforeStart }).catch(cause => cause)
    expect(failure).toBeInstanceOf(StageUnsupportedError)
    expect((failure as StageUnsupportedError).support.missing).toContain('html-in-canvas')
    expect(beforeStart).not.toHaveBeenCalled()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('可以在回退模式下固定主题', async () => {
    document.documentElement.dataset.theme = 'dark'
    const mount = await mountLiquidGlass({ root, mode: 'css' })
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(23, 27, 32, 0.24)')
    mount.setTheme('light')
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(246, 246, 248, 0.26)')
    mount.dispose()
    delete document.documentElement.dataset.theme
  })
})

describe('通过 API 开关玻璃', () => {
  it('addGlass 写上玻璃与参数属性，回退实现在下一次变更回调里接手；removeGlass 只去掉自己写的属性', async () => {
    const root = document.createElement('div')
    const button = document.createElement('button')
    button.setAttribute('data-glass-layer', '2')
    root.append(button)
    document.body.append(root)
    const mount = await mountLiquidGlass({ root, mode: 'css' })
    const handle = mount.addGlass(button, {
      variant: 'clear',
      bevelWidth: 1.2,
      radius: '12 12 0 0',
      materialize: false,
    })
    expect(button.getAttribute('data-liquid-glass')).toBe('')
    expect(button.getAttribute('data-glass-variant')).toBe('clear')
    expect(button.getAttribute('data-glass-bevel-width')).toBe('1.2')
    expect(button.getAttribute('data-glass-radius')).toBe('12 12 0 0')
    expect(button.getAttribute('data-glass-materialize')).toBe('false')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.hasAttribute('data-liquid-glass-css')).toBe(true)

    handle.update({ bevelWidth: null, blur: 4 })
    expect(button.hasAttribute('data-glass-bevel-width')).toBe(false)
    expect(button.getAttribute('data-glass-blur')).toBe('4')

    handle.remove()
    expect(button.hasAttribute('data-liquid-glass')).toBe(false)
    expect(button.hasAttribute('data-glass-variant')).toBe(false)
    expect(button.hasAttribute('data-glass-blur')).toBe(false)
    expect(button.getAttribute('data-glass-layer')).toBe('2')
    handle.update({ blur: 8 })
    expect(button.hasAttribute('data-glass-blur')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(button.hasAttribute('data-liquid-glass-css')).toBe(false)

    mount.dispose()
    root.remove()
  })

  it('元素不在根元素里、或参数名未知时抛出错误', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const mount = await mountLiquidGlass({ root, mode: 'css' })
    expect(() => mount.addGlass(document.createElement('div'))).toThrow(/inside the mounted root/)
    const inside = document.createElement('div')
    root.append(inside)
    expect(() => mount.addGlass(inside, { blurry: 1 } as never)).toThrow(/Unknown glass option/)
    mount.dispose()
    root.remove()
  })
})
