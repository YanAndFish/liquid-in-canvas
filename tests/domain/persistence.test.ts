import type { StorageLike } from '@/domain/persistence'
import { describe, expect, it } from 'vitest'
import { CART_STORAGE_KEY, readCart, sanitizeLines, writeCart } from '@/domain/persistence'

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('sanitizeLines', () => {
  it('rejects non-array input', () => {
    expect(sanitizeLines(null)).toEqual([])
    expect(sanitizeLines(undefined)).toEqual([])
    expect(sanitizeLines({ productId: 'throw-01', quantity: 1 })).toEqual([])
    expect(sanitizeLines('throw-01')).toEqual([])
  })

  it('drops corrupt entries and unknown product ids', () => {
    expect(sanitizeLines([
      null,
      undefined,
      'throw-01',
      42,
      {},
      { productId: 'throw-01' },
      { productId: 'throw-01', quantity: 0 },
      { productId: 'throw-01', quantity: -2 },
      { productId: 'throw-01', quantity: 1.5 },
      { productId: 'not-a-product', quantity: 2 },
      { productId: 2, quantity: 2 },
    ])).toEqual([])
  })

  it('clamps quantities to the maximum', () => {
    expect(sanitizeLines([
      { productId: 'lantern-06', quantity: 100 },
    ]))
      .toEqual([
        { productId: 'lantern-06', quantity: 99 },
      ])
  })

  it('dedupes product ids and sums their quantities', () => {
    expect(sanitizeLines([
      { productId: 'throw-01', quantity: 2 },
      { productId: 'carafe-02', quantity: 1 },
      { productId: 'throw-01', quantity: 100 },
    ])).toEqual([
      { productId: 'throw-01', quantity: 99 },
      { productId: 'carafe-02', quantity: 1 },
    ])
  })
})

describe('cart storage', () => {
  it('round-trips valid lines', () => {
    const storage = createMemoryStorage()
    const lines = [
      { productId: 'candle-04' as const, quantity: 2 },
      { productId: 'towel-05' as const, quantity: 1 },
    ]

    writeCart(storage, lines)

    expect(readCart(storage)).toEqual(lines)
  })

  it('survives invalid JSON', () => {
    const storage = createMemoryStorage()
    storage.setItem(CART_STORAGE_KEY, '{not json')

    expect(readCart(storage)).toEqual([])
  })

  it('survives a throwing getItem', () => {
    const storage: StorageLike = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {},
    }

    expect(readCart(storage)).toEqual([])
  })

  it('survives a throwing setItem', () => {
    const storage: StorageLike = {
      getItem() {
        return null
      },
      setItem() {
        throw new Error('blocked')
      },
    }

    expect(() => writeCart(storage, [
      { productId: 'throw-01', quantity: 1 },
    ])).not.toThrow()
  })
})
