import type { StorageLike } from '@/domain/persistence'
import { describe, expect, it } from 'vitest'
import { isReadonly } from 'vue'
import { CART_STORAGE_KEY, readCart, writeCart } from '@/domain/persistence'
import { createCartStore } from '@/stores/cart'

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('createCartStore', () => {
  it('hydrates persisted lines', () => {
    const storage = createMemoryStorage()
    writeCart(storage, [
      { productId: 'throw-01', quantity: 2 },
      { productId: 'lantern-06', quantity: 1 },
    ])

    const store = createCartStore({ storage })

    expect(store.state.value.lines).toEqual([
      { productId: 'throw-01', quantity: 2 },
      { productId: 'lantern-06', quantity: 1 },
    ])
    expect(store.lines.value.map(item => item.product.id)).toEqual(['throw-01', 'lantern-06'])
    expect(store.totals.value.itemCount).toBe(3)
  })

  it('adds, merges, and persists lines', () => {
    const storage = createMemoryStorage()
    const store = createCartStore({ storage })

    store.add('carafe-02')
    store.add('carafe-02')

    expect(store.state.value.lines).toEqual([
      { productId: 'carafe-02', quantity: 2 },
    ])
    expect(readCart(storage)).toEqual([
      { productId: 'carafe-02', quantity: 2 },
    ])

    store.increment('carafe-02')

    expect(readCart(storage)).toEqual([
      { productId: 'carafe-02', quantity: 3 },
    ])
  })

  it('keeps insertion order across products', () => {
    const store = createCartStore({ storage: null })

    store.add('lantern-06')
    store.add('throw-01')
    store.add('lantern-06')

    expect(store.state.value.lines).toEqual([
      { productId: 'lantern-06', quantity: 2 },
      { productId: 'throw-01', quantity: 1 },
    ])
  })

  it('clamps increments and removes a line at zero', () => {
    const store = createCartStore({ storage: null })

    store.add('board-03')
    for (let index = 0; index < 120; index++)
      store.increment('board-03')

    expect(store.state.value.lines).toEqual([
      { productId: 'board-03', quantity: 99 },
    ])

    store.decrement('board-03')
    expect(store.state.value.lines).toEqual([
      { productId: 'board-03', quantity: 98 },
    ])

    for (let index = 0; index < 98; index++)
      store.decrement('board-03')

    expect(store.state.value.lines).toEqual([])
  })

  it('removes and clears lines', () => {
    const store = createCartStore({ storage: null })

    store.add('throw-01')
    store.add('carafe-02')
    store.remove('throw-01')

    expect(store.state.value.lines).toEqual([
      { productId: 'carafe-02', quantity: 1 },
    ])

    store.clear()
    expect(store.state.value.lines).toEqual([])
    expect(store.totals.value.totalCents).toBe(0)
  })

  it('ignores corrupt storage and recovers on add', () => {
    const storage = createMemoryStorage()
    storage.setItem(CART_STORAGE_KEY, 'not json')

    const store = createCartStore({ storage })

    expect(store.state.value.lines).toEqual([])

    store.add('towel-05')

    expect(store.state.value.lines).toEqual([
      { productId: 'towel-05', quantity: 1 },
    ])
    expect(readCart(storage)).toEqual([
      { productId: 'towel-05', quantity: 1 },
    ])
  })

  it('keeps working when storage throws', () => {
    const storage: StorageLike = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
    }

    const store = createCartStore({ storage })

    expect(store.state.value.lines).toEqual([])
    expect(() => store.add('board-03')).not.toThrow()
    expect(store.state.value.lines).toEqual([
      { productId: 'board-03', quantity: 1 },
    ])
    expect(store.totals.value.subtotalCents).toBe(5400)
  })

  it('exposes readonly state', () => {
    const store = createCartStore({ storage: null })

    expect(isReadonly(store.state)).toBe(true)
  })
})
