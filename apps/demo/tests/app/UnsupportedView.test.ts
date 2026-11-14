import type { StageFault } from 'liquid-in-canvas'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { useLocale } from '@/composables/useLocale'
import UnsupportedView from '@/pages/UnsupportedView.vue'

const { setLocale } = useLocale()

beforeEach(() => setLocale('en'))

const fault: StageFault = {
  kind: 'unsupported',
  support: {
    supported: false,
    missing: ['webgpu'],
    report: {
      htmlInCanvas: true,
      webgpu: false,
      drawElementImageToTexture: true,
      browser: 'Chrome 140',
    },
  },
}

describe('unsupportedView', () => {
  it('explains the Chrome requirement and lists the capability checks', () => {
    const wrapper = mount(UnsupportedView, {
      props: { fault },
    })
    const text = wrapper.text()

    expect(text).toContain('Chrome 157')
    expect(text).toContain('HTML-in-Canvas')
    expect(text).toContain('WebGPU')
    expect(text).toContain('Chrome 140')
  })

  it('只有用户点击按钮才会请求 CSS 回退', async () => {
    const wrapper = mount(UnsupportedView, {
      props: { fault },
    })
    expect(wrapper.emitted('continue')).toBeUndefined()
    await wrapper.get('button[data-action="continue"]').trigger('click')
    expect(wrapper.emitted('continue')).toHaveLength(1)
  })
})
