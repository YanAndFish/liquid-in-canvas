import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from '@/App.vue'
import { useLocale } from '@/composables/useLocale'
import { routes } from '@/router/routes'
import { CART_KEY, createCartStore } from '@/stores/cart'

const { setLocale } = useLocale()

beforeEach(() => setLocale('en'))

async function mountAt(path: string) {
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

describe('product detail', () => {
  it('renders the product, specs, and related objects', async () => {
    const { wrapper } = await mountAt('/product/linen-throw')

    expect(wrapper.find('h1').text()).toBe('Linen Throw')
    expect(wrapper.text()).toContain('$128')
    expect(wrapper.text()).toContain('100% washed European linen')
    expect(wrapper.text()).toContain('130 × 180 cm')
    expect(wrapper.text()).toContain('More from the collection')
    expect(wrapper.findAll('article')).toHaveLength(3)
  })

  it('adds the product from the detail page', async () => {
    const { store, wrapper } = await mountAt('/product/linen-throw')

    const button = wrapper.findAll('button').find(item => item.text().includes('Add to bag'))
    expect(button).toBeDefined()
    await button!.trigger('click')

    expect(store.totals.value.itemCount).toBe(1)
    expect(wrapper.text()).toContain('Added to bag')
  })

  it('shows a not found panel for an unknown product', async () => {
    const { wrapper } = await mountAt('/product/not-real')

    expect(wrapper.text()).toContain('This object is no longer here.')
    expect(wrapper.text()).toContain('Back to collection')
  })
})
