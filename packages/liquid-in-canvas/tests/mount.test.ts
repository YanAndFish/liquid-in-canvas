import type { StageFault } from '../src/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GLASS_CSS_ATTR } from '../src/css/CssGlassStage'
import { mountLiquidGlass, StageUnsupportedError } from '../src/mount'

// jsdom 没有 HTML-in-Canvas 与 WebGPU，这里覆盖的是不支持时的行为。
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
    // 回退不改变页面结构。
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
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(23, 27, 32, 0.28)')
    mount.setTheme('light')
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(246, 246, 248, 0.32)')
    mount.dispose()
    delete document.documentElement.dataset.theme
  })
})
