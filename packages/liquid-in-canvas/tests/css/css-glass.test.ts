import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cssGlassProperties, CssGlassStage, GLASS_CSS_ATTR } from '../../src/css/CssGlassStage'
import { getGlassDefaults, resetGlassDefaults, setGlassDefaults } from '../../src/liquid-glass/defaults'
import { parseGlassOptions } from '../../src/liquid-glass/options'

/** MutationObserver 的回调在微任务中执行。 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function glass(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-liquid-glass', '')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  return element
}

let root: HTMLElement
let stage: CssGlassStage

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark'
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  stage?.dispose()
  root.remove()
  resetGlassDefaults()
  delete document.documentElement.dataset.theme
})

describe('cssGlassProperties', () => {
  it('把玻璃参数换算成自定义属性', () => {
    const properties = cssGlassProperties(parseGlassOptions(glass({ 'data-glass-radius': '10 20' }), 'dark'))
    expect(properties['--lg-blur']).toBe('18px')
    expect(properties['--lg-tint']).toBe('rgba(23, 27, 32, 0.28)')
    expect(properties['--lg-radius']).toBe('10px 20px 10px 20px')
    expect(properties['--lg-shadow']).toContain('0 4px 24px rgba(0, 0, 0, 0.192)')
    expect(properties['--lg-shadow']).toContain('inset 0 0 0 1px')
  })

  it('阴影强度为零时不输出外阴影', () => {
    const properties = cssGlassProperties(parseGlassOptions(glass({ 'data-glass-shadow': '0' }), 'dark'))
    expect(properties['--lg-shadow']).not.toContain('0 4px')
  })
})

describe('cssGlassStage', () => {
  it('为已有的玻璃写入样式并安装样式表', () => {
    const element = glass()
    root.append(element)
    stage = new CssGlassStage({ root })
    stage.start()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(true)
    expect(element.style.getPropertyValue('--lg-blur')).toBe('18px')
    expect(document.getElementById('liquid-in-canvas-css')?.textContent).toContain('backdrop-filter')
  })

  it('嵌套在玻璃里的玻璃不单独处理', () => {
    const outer = glass()
    const inner = glass()
    outer.append(inner)
    root.append(outer)
    stage = new CssGlassStage({ root })
    stage.start()
    expect(outer.hasAttribute(GLASS_CSS_ATTR)).toBe(true)
    expect(inner.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
  })

  it('跟随后来加入、修改和取消声明的元素', async () => {
    stage = new CssGlassStage({ root })
    stage.start()
    const element = glass({ 'data-glass-blur': '6' })
    root.append(element)
    await flush()
    expect(element.style.getPropertyValue('--lg-blur')).toBe('6px')

    element.setAttribute('data-glass-blur', '30')
    await flush()
    expect(element.style.getPropertyValue('--lg-blur')).toBe('30px')

    element.removeAttribute('data-liquid-glass')
    await flush()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
    expect(element.style.getPropertyValue('--lg-blur')).toBe('')
  })

  it('全局默认参数变化时更新未单独声明的属性', () => {
    const plain = glass()
    const explicit = glass({ 'data-glass-blur': '6' })
    root.append(plain, explicit)
    stage = new CssGlassStage({ root })
    stage.start()
    setGlassDefaults({
      materials: {
        regular: {
          dark: { blur: 40 },
        },
      },
    })
    expect(getGlassDefaults().materials.regular.dark.blur).toBe(40)
    expect(plain.style.getPropertyValue('--lg-blur')).toBe('40px')
    expect(explicit.style.getPropertyValue('--lg-blur')).toBe('6px')
  })

  it('主题变化时改用对应的材质', async () => {
    const element = glass()
    root.append(element)
    stage = new CssGlassStage({ root })
    stage.start()
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(23, 27, 32, 0.28)')
    document.documentElement.dataset.theme = 'light'
    await flush()
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(246, 246, 248, 0.32)')
    stage.setTheme('dark')
    expect(element.style.getPropertyValue('--lg-tint')).toBe('rgba(23, 27, 32, 0.28)')
  })

  it('销毁后页面恢复原状，不再响应默认参数', () => {
    const element = glass()
    element.style.color = 'red'
    root.append(element)
    stage = new CssGlassStage({ root })
    stage.start()
    stage.dispose()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
    expect(element.getAttribute('style')).toBe('color: red;')
    expect(document.getElementById('liquid-in-canvas-css')).toBeNull()
    setGlassDefaults({
      materials: {
        regular: {
          dark: { blur: 40 },
        },
      },
    })
    expect(element.style.getPropertyValue('--lg-blur')).toBe('')
  })
})
