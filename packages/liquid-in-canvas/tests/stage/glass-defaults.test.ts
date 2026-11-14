import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_GLASS_DEFAULTS,
  getGlassDefaults,
  onGlassDefaultsChange,
  resetGlassDefaults,
  setGlassDefaults,
} from '../../src/liquid-glass/defaults'
import { parseGlassOptions } from '../../src/liquid-glass/options'

function makeElement(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  return element
}

afterEach(() => {
  resetGlassDefaults()
})

describe('全局默认参数', () => {
  it('初始值是库内置的默认参数', () => {
    expect(getGlassDefaults()).toBe(BUILTIN_GLASS_DEFAULTS)
  })

  it('只修改补丁中列出的字段', () => {
    setGlassDefaults({
      fusion: 48,
      materials: {
        regular: {
          dark: { blur: 30 },
        },
      },
    })
    const defaults = getGlassDefaults()
    expect(defaults.fusion).toBe(48)
    expect(defaults.elevation).toBe(16)
    expect(defaults.materials.regular.dark.blur).toBe(30)
    expect(defaults.materials.regular.dark.refraction).toBe(80)
    expect(defaults.materials.regular.light.blur).toBe(18)
    expect(defaults.materials.clear.dark).toEqual(BUILTIN_GLASS_DEFAULTS.materials.clear.dark)
  })

  it('数值限制在允许范围内，无效值被忽略', () => {
    setGlassDefaults({
      fusion: 500,
      elevation: Number.NaN,
      materials: {
        clear: {
          light: { dispersion: -3, tint: 'not-a-color', specular: 9 },
        },
      },
    })
    const defaults = getGlassDefaults()
    expect(defaults.fusion).toBe(100)
    expect(defaults.elevation).toBe(16)
    expect(defaults.materials.clear.light.dispersion).toBe(0)
    expect(defaults.materials.clear.light.specular).toBe(2)
    expect(defaults.materials.clear.light.tint).toBe('#f7f2e8')
  })

  it('染色规范为小写六位十六进制', () => {
    setGlassDefaults({
      materials: {
        regular: {
          dark: { tint: '#ABC' },
        },
      },
    })
    expect(getGlassDefaults().materials.regular.dark.tint).toBe('#aabbcc')
  })

  it('返回的对象不可修改，内置默认值不会被污染', () => {
    setGlassDefaults({ fusion: 40 })
    expect(() => {
      (getGlassDefaults() as { fusion: number }).fusion = 1
    }).toThrow()
    expect(BUILTIN_GLASS_DEFAULTS.fusion).toBe(32)
  })

  it('只在值确实变化时通知监听者，取消后不再通知', () => {
    const listener = vi.fn()
    const stop = onGlassDefaultsChange(listener)
    setGlassDefaults({ fusion: 32 })
    expect(listener).not.toHaveBeenCalled()
    setGlassDefaults({ fusion: 40 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(getGlassDefaults())
    resetGlassDefaults()
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    setGlassDefaults({ fusion: 50 })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('默认参数与元素属性', () => {
  it('未声明的属性取全局默认值', () => {
    setGlassDefaults({
      radius: 12,
      fusion: 8,
      materials: {
        clear: {
          dark: { blur: 4, tint: '#102030' },
        },
      },
    })
    const options = parseGlassOptions(makeElement({ 'data-glass-variant': 'clear' }), 'dark')
    expect(options.radius).toEqual([12, 12, 12, 12])
    expect(options.fusion).toBe(8)
    expect(options.blur).toBe(4)
    expect(options.tint).toBe('#102030')
  })

  it('元素上的属性优先于全局默认值', () => {
    setGlassDefaults({
      fusion: 8,
      materials: {
        regular: {
          light: { blur: 4 },
        },
      },
    })
    const options = parseGlassOptions(makeElement({ 'data-glass-blur': '30', 'data-glass-fusion': '60' }), 'light')
    expect(options.blur).toBe(30)
    expect(options.fusion).toBe(60)
  })

  it('可以传入一份默认参数而不读取全局值', () => {
    setGlassDefaults({ fusion: 8 })
    expect(parseGlassOptions(makeElement(), 'dark', BUILTIN_GLASS_DEFAULTS).fusion).toBe(32)
  })
})
