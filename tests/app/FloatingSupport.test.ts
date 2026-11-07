import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import FloatingSupport from '@/components/support/FloatingSupport.vue'
import { clampSupportPosition, supportPanelPosition } from '@/components/support/position'

vi.mock('@/composables/useLocale', async () => {
  const { ref } = await import('vue')
  return {
    useLocale: () => ({
      isChinese: ref(true),
    }),
  }
})
vi.mock('@/composables/useTheme', async () => {
  const { ref } = await import('vue')
  return {
    useTheme: () => ({
      theme: ref('dark'),
    }),
  }
})
vi.mock('@/composables/useSpring', async () => {
  const { computed } = await import('vue')
  return {
    useSpring: (target: () => number) => computed(target),
  }
})

let wrapper: ReturnType<typeof mount<typeof FloatingSupport>>
beforeEach(() => {
  vi.useFakeTimers()
  wrapper = mount(FloatingSupport, { attachTo: document.body })
})
afterEach(() => {
  wrapper.unmount()
  vi.useRealTimers()
})

describe('客服演示交互', () => {
  it('点击打开对话框后 Escape 关闭并恢复入口焦点', async () => {
    const launcher = wrapper.get('.support-launcher')
    launcher.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await nextTick()
    expect(wrapper.get('[role="dialog"]').attributes('aria-hidden')).toBe('false')
    await wrapper.get('input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(launcher.element)
  })

  it('发送后显示本地回复并清空输入框', async () => {
    await wrapper.get('.support-launcher').trigger('click')
    await wrapper.get('input').setValue('配送方式')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('input').element.value).toBe('')
    expect(wrapper.text()).toContain('正在回复')
    await vi.advanceTimersByTimeAsync(600)
    expect(wrapper.text()).toContain('商品满 $150 免运费')
    expect(wrapper.findAll('.is-user')).toHaveLength(1)
  })

  it('空白消息不会加入对话', async () => {
    await wrapper.get('.support-launcher').trigger('click')
    await wrapper.get('input').setValue('   ')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.findAll('.is-user')).toHaveLength(0)
  })

  it('拖动后产生的点击不会打开对话框', async () => {
    const launcher = wrapper.get('.support-launcher')
    Object.assign(launcher.element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
    })
    launcher.element.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 900,
      clientY: 600,
    }))
    launcher.element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 700, clientY: 400 }))
    launcher.element.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 700, clientY: 400 }))
    launcher.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('.support-launcher-anchor').attributes('style')).toContain('left: 732px')
  })

  it('购物袋打开时关闭并隐藏客服', async () => {
    await wrapper.get('.support-launcher').trigger('click')
    await wrapper.setProps({ disabled: true })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('.support-root').attributes('style')).toContain('display: none')
  })
})

describe('客服位置', () => {
  it('拖出视口时按钮被限制在边缘内', () => {
    expect(clampSupportPosition({ x: -200, y: 900 }, { x: 390, y: 844 }, 56)).toEqual({ x: 12, y: 776 })
  })

  it('按钮在顶部时对话框向下展开', () => {
    expect(supportPanelPosition({ x: 12, y: 12 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)).toEqual({ x: 12, y: 80 })
  })

  it('按钮在底部时对话框向上展开', () => {
    const result = supportPanelPosition({ x: 310, y: 760 }, { x: 390, y: 844 }, { x: 360, y: 480 }, 56)
    expect(result).toEqual({ x: 12, y: 268 })
  })
})
