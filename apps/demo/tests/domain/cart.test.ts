import type { CartState } from '@/domain/types'
import { describe, expect, it } from 'vitest'
import { selectLineItems, selectTotals } from '@/domain/cart'
import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_CENTS } from '@/domain/money'

describe('selectLineItems', () => {
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
  })
})

describe('selectTotals', () => {
  it('computes subtotal, shipping, and total', () => {
    const state: CartState = {
      lines: [
        { productId: 'throw-01', quantity: 2 },
        { productId: 'carafe-02', quantity: 1 },
      ],
    }

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

    const below: CartState = {
      lines: [
        { productId: 'throw-01', quantity: 1 },
      ],
    }
    const belowTotals = selectTotals(below)

    expect(belowTotals.subtotalCents).toBe(12800)
    expect(belowTotals.freeShipping).toBe(false)
    expect(belowTotals.shippingCents).toBe(FLAT_SHIPPING_CENTS)
    expect(belowTotals.totalCents).toBe(14000)
    expect(belowTotals.remainingForFreeShippingCents).toBe(FREE_SHIPPING_CENTS - 12800)
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
