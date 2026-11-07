import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GlassShowcase from '@/components/home/GlassShowcase.vue'
import { useLocale } from '@/composables/useLocale'

beforeEach(() => {
  useLocale().setLocale('en')
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('场景控件', () => {
  it('减少动态效果开启时等待用户手动播放', async () => {
    const wrapper = mount(GlassShowcase)
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="Play background video"]').trigger('click')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(wrapper.find('[aria-label="Pause background video"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('切换场景后保留用户的暂停选择', async () => {
    const wrapper = mount(GlassShowcase)
    await wrapper.get('[aria-label="Play background video"]').trigger('click')
    await wrapper.get('[aria-label="Pause background video"]').trigger('click')
    const sceneButtons = wrapper.findAll('.scene-controls button')
    await sceneButtons[1]!.trigger('click')
    expect(wrapper.get('.scene-play').attributes('disabled')).toBeDefined()
    await sceneButtons[0]!.trigger('click')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()
    expect(wrapper.find('[aria-label="Play background video"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('按 Escape 关闭设置后隐藏其中的可聚焦控件', async () => {
    const wrapper = mount(GlassShowcase)
    const trigger = wrapper.get('[aria-label="Appearance settings"]')
    await trigger.trigger('click')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#glass-settings').attributes('aria-hidden')).toBe('false')
    await trigger.trigger('keydown', { key: 'Escape' })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('#glass-settings').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('#glass-settings').attributes('inert')).toBeDefined()
    wrapper.unmount()
  })
})
