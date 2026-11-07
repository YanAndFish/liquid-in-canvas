import type { CartLineItem, CartState, CartTotals } from './types'
import { PRODUCT_BY_ID } from './catalog'
import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_CENTS } from './money'

export const MAX_LINE_QUANTITY = 99

export function selectLineItems(state: CartState): CartLineItem[] {
  const items: CartLineItem[] = []
  for (const line of state.lines) {
    const product = PRODUCT_BY_ID.get(line.productId)
    if (!product)
      continue
    items.push({
      product,
      quantity: line.quantity,
      lineTotalCents: product.priceCents * line.quantity,
    })
  }
  return items
}

export function selectTotals(state: CartState): CartTotals {
  const items = selectLineItems(state)
  const itemCount = items.reduce((count, item) => count + item.quantity, 0)
  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0)
  const freeShipping = subtotalCents >= FREE_SHIPPING_CENTS
  const shippingCents = items.length === 0 || freeShipping
    ? 0
    : FLAT_SHIPPING_CENTS

  return {
    itemCount,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    remainingForFreeShippingCents: Math.max(0, FREE_SHIPPING_CENTS - subtotalCents),
    freeShipping,
  }
}
