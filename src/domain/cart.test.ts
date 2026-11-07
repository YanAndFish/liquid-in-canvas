import type { CartLine, CartState } from './types'
import { describe, expect, it } from 'vitest'
import { cartReducer, MAX_LINE_QUANTITY, selectLineItems, selectTotals } from './cart'
import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_CENTS } from './money'

describe('cartReducer', () => {
  it('merges repeated adds and preserves first-add order', () => {
    const empty: CartState = { lines: [] }
    const once = cartReducer(empty, { type: 'add', productId: 'throw-01' })
    const twice = cartReducer(once, { type: 'add', productId: 'throw-01' })
    const withCarafe = cartReducer(twice, { type: 'add', productId: 'carafe-02' })
    const throwAgain = cartReducer(withCarafe, { type: 'add', productId: 'throw-01' })

    expect(twice.lines).toEqual([
      { productId: 'throw-01', quantity: 2 },
    ])
    expect(throwAgain.lines).toEqual([
      { productId: 'throw-01', quantity: 3 },
      { productId: 'carafe-02', quantity: 1 },
    ])
  })

  it('clamps increments at the maximum quantity', () => {
    const state: CartState = {
      lines: [
        { productId: 'throw-01', quantity: MAX_LINE_QUANTITY },
      ],
    }

    const incremented = cartReducer(state, { type: 'increment', productId: 'throw-01' })
    const decremented = cartReducer(incremented, { type: 'decrement', productId: 'throw-01' })

    expect(incremented.lines).toEqual([
      { productId: 'throw-01', quantity: MAX_LINE_QUANTITY },
    ])
    expect(decremented.lines).toEqual([
      { productId: 'throw-01', quantity: MAX_LINE_QUANTITY - 1 },
    ])
  })

  it('removes a line when decrementing from one', () => {
    const state: CartState = {
      lines: [
        { productId: 'carafe-02', quantity: 1 },
        { productId: 'throw-01', quantity: 2 },
      ],
    }

    const next = cartReducer(state, { type: 'decrement', productId: 'carafe-02' })

    expect(next.lines).toEqual([
      { productId: 'throw-01', quantity: 2 },
    ])
  })

  it('removes and clears lines', () => {
    const state: CartState = {
      lines: [
        { productId: 'throw-01', quantity: 2 },
        { productId: 'carafe-02', quantity: 1 },
      ],
    }

    expect(cartReducer(state, { type: 'remove', productId: 'throw-01' }).lines)
      .toEqual([
        { productId: 'carafe-02', quantity: 1 },
      ])
    expect(cartReducer(state, { type: 'clear' }).lines).toEqual([])
    expect(state.lines).toHaveLength(2)
  })

  it('hydrates with copied lines', () => {
    const source: CartLine[] = [
      { productId: 'lantern-06', quantity: 2 },
    ]
    const next = cartReducer({ lines: [] }, { type: 'hydrate', lines: source })

    expect(next.lines).toEqual(source)
    expect(next.lines[0]).not.toBe(source[0])
  })

  it('does not mutate the input state', () => {
    const line = Object.freeze({ productId: 'throw-01' as const, quantity: 2 })
    const state = Object.freeze({
      lines: Object.freeze([line]),
    })

    const next = cartReducer(state, { type: 'increment', productId: 'throw-01' })

    expect(next).not.toBe(state)
    expect(next.lines).not.toBe(state.lines)
    expect(next.lines).toEqual([
      { productId: 'throw-01', quantity: 3 },
    ])
    expect(state.lines).toEqual([
      { productId: 'throw-01', quantity: 2 },
    ])
  })
})

describe('selectors', () => {
  it('joins catalog products and computes line totals', () => {
    const state: CartState = {
      lines: [
        { productId: 'throw-01', quantity: 2 },
        { productId: 'carafe-02', quantity: 1 },
      ],
    }

    const items = selectLineItems(state)

    expect(items.map(item => [item.product.id, item.quantity, item.lineTotalCents])).toEqual([
      ['throw-01', 2, 25600],
      ['carafe-02', 1, 7600],
    ])
    expect(selectTotals(state)).toEqual({
      itemCount: 3,
      subtotalCents: 33200,
      shippingCents: 0,
      totalCents: 33200,
      remainingForFreeShippingCents: 0,
      freeShipping: true,
    })
  })

  it('crosses the free shipping threshold in both directions', () => {
    const free: CartState = {
      lines: [
        { productId: 'throw-01', quantity: 2 },
      ],
    }
    const freeTotals = selectTotals(free)

    expect(freeTotals.subtotalCents).toBe(25600)
    expect(freeTotals.freeShipping).toBe(true)
    expect(freeTotals.shippingCents).toBe(0)

    const below = cartReducer(free, { type: 'decrement', productId: 'throw-01' })
    const belowTotals = selectTotals(below)

    expect(belowTotals.subtotalCents).toBe(12800)
    expect(belowTotals.freeShipping).toBe(false)
    expect(belowTotals.shippingCents).toBe(FLAT_SHIPPING_CENTS)
    expect(belowTotals.totalCents).toBe(14000)
    expect(belowTotals.remainingForFreeShippingCents).toBe(FREE_SHIPPING_CENTS - 12800)

    const backOver = cartReducer(below, { type: 'increment', productId: 'throw-01' })

    expect(selectTotals(backOver).freeShipping).toBe(true)
    expect(selectTotals(backOver).shippingCents).toBe(0)
  })

  it('returns zero totals for an empty cart', () => {
    expect(selectTotals({ lines: [] })).toEqual({
      itemCount: 0,
      subtotalCents: 0,
      shippingCents: 0,
      totalCents: 0,
      remainingForFreeShippingCents: FREE_SHIPPING_CENTS,
      freeShipping: false,
    })
  })
})
