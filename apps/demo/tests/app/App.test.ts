import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '@/App.vue'
import { useLocale } from '@/composables/useLocale'
import { routes } from '@/router/routes'
import { CART_KEY, createCartStore } from '@/stores/cart'

const { setLocale } = useLocale()

beforeEach(() => setLocale('en'))

async function mountApp(path = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes,
  })
  await router.push(path)
  await router.isReady()

  const store = createCartStore({ storage: null })
  const wrapper = mount(App, {
    global: {
      plugins: [router],
      provide: {
        [CART_KEY]: store,
      },
    },
  })
  await flushPromises()
  return { store, wrapper, router }
}

describe('storefront', () => {
  it('shows all twelve objects and filters the grid by category', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.findAll('article')).toHaveLength(12)

    const kitchen = wrapper.findAll('button').find(button => button.text().startsWith('Kitchen'))
    expect(kitchen).toBeDefined()
    await kitchen!.trigger('click')

    expect(wrapper.findAll('article')).toHaveLength(4)
    expect(wrapper.text()).toContain('Stoneware Carafe')
    expect(wrapper.text()).toContain('Oak Board')
    expect(wrapper.text()).toContain('Enamel Mug')
    expect(wrapper.text()).toContain('Walnut Servers')
  })

  it('links product cards to detail routes', async () => {
    const { wrapper } = await mountApp()

    expect(wrapper.find('a[href="/product/linen-throw"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/product/bath-brush"]').exists()).toBe(true)
  })

  it('adds an object to the bag and feeds the header count', async () => {
    const { store, wrapper } = await mountApp()

    await wrapper.find('[aria-label="Add Linen Throw to bag"]').trigger('click')

    expect(store.totals.value.itemCount).toBe(1)
    expect(wrapper.find('[aria-label="Bag1"]').exists()).toBe(true)
  })

  it('adds distinct objects on separate lines', async () => {
    const { store, wrapper } = await mountApp()

    await wrapper.find('[aria-label="Add Linen Throw to bag"]').trigger('click')
    await wrapper.find('[aria-label="Add Stoneware Carafe to bag"]').trigger('click')

    expect(store.lines.value.map(line => [line.product.name.en, line.quantity])).toEqual([
      ['Linen Throw', 1],
      ['Stoneware Carafe', 1],
    ])
  })

  it('switches the interface to Simplified Chinese', async () => {
    const { wrapper } = await mountApp()

    const chinese = wrapper.findAll('button').find(button => button.text() === '简')
    expect(chinese).toBeDefined()
    await chinese!.trigger('click')

    expect(wrapper.text()).toContain('亚麻盖毯')
    expect(wrapper.find('h1').text()).toContain('让家')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('toggles the light theme from the header', async () => {
    const { wrapper } = await mountApp()

    const toLight = wrapper.find('[aria-label="Switch to light theme"]')
    expect(toLight.exists()).toBe(true)
    await toLight.trigger('click')

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(wrapper.find('[aria-label="Switch to dark theme"]').exists()).toBe(true)

    await wrapper.find('[aria-label="Switch to dark theme"]').trigger('click')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
