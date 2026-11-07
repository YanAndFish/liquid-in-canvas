import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '@/App.vue'
import { CART_KEY, createCartStore } from '@/composables/useCart'
import { useLocale } from '@/composables/useLocale'

const { setLocale } = useLocale()

beforeEach(() => setLocale('en'))

function mountApp() {
  const store = createCartStore({ storage: null })
  const wrapper = mount(App, {
    global: {
      provide: {
        [CART_KEY]: store,
      },
    },
  })
  return { store, wrapper }
}

describe('storefront', () => {
  it('shows all six objects and filters the grid by category', async () => {
    const { wrapper } = mountApp()

    expect(wrapper.findAll('article')).toHaveLength(6)

    const kitchen = wrapper.findAll('button').find(button => button.text().startsWith('Kitchen'))
    expect(kitchen).toBeDefined()
    await kitchen!.trigger('click')

    expect(wrapper.findAll('article')).toHaveLength(2)
    expect(wrapper.text()).toContain('Stoneware Carafe')
    expect(wrapper.text()).toContain('Oak Board')
  })

  it('adds an object to the bag and feeds the header count', async () => {
    const { store, wrapper } = mountApp()

    await wrapper.find('[aria-label="Add Linen Throw to bag"]').trigger('click')

    expect(store.totals.value.itemCount).toBe(1)
    expect(wrapper.find('[aria-label="Bag1"]').exists()).toBe(true)
  })

  it('adds distinct objects on separate lines', async () => {
    const { store, wrapper } = mountApp()

    await wrapper.find('[aria-label="Add Linen Throw to bag"]').trigger('click')
    await wrapper.find('[aria-label="Add Stoneware Carafe to bag"]').trigger('click')

    expect(store.lines.value.map(line => [line.product.name.en, line.quantity])).toEqual([
      ['Linen Throw', 1],
      ['Stoneware Carafe', 1],
    ])
  })

  it('switches the interface to Simplified Chinese', async () => {
    const { wrapper } = mountApp()

    const chinese = wrapper.findAll('button').find(button => button.text() === '简')
    expect(chinese).toBeDefined()
    await chinese!.trigger('click')

    expect(wrapper.text()).toContain('亚麻盖毯')
    expect(wrapper.find('h1').text()).toContain('让家')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('toggles the light theme from the header', async () => {
    const { wrapper } = mountApp()

    const toLight = wrapper.find('[aria-label="Switch to light theme"]')
    expect(toLight.exists()).toBe(true)
    await toLight.trigger('click')

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(wrapper.find('[aria-label="Switch to dark theme"]').exists()).toBe(true)

    await wrapper.find('[aria-label="Switch to dark theme"]').trigger('click')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
