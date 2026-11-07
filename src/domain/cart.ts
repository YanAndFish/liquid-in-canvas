import type { CartAction, CartLine, CartLineItem, CartState, CartTotals, ProductId } from './types'
import { PRODUCT_BY_ID } from './catalog'
import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_CENTS } from './money'

export const MAX_LINE_QUANTITY = 99

function updateLine(
  lines: readonly CartLine[],
  productId: ProductId,
  transform: (quantity: number) => number | null,
): readonly CartLine[] {
  const next: CartLine[] = []
  for (const line of lines) {
    if (line.productId !== productId) {
      next.push(line)
      continue
    }
    const quantity = transform(line.quantity)
    if (quantity !== null)
      next.push({ productId: line.productId, quantity })
  }
  return next
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const exists = state.lines.some(line => line.productId === action.productId)
      if (!exists) {
        return {
          lines: [
            ...state.lines,
            { productId: action.productId, quantity: 1 },
          ],
        }
      }
      return {
        lines: state.lines.map(line => line.productId === action.productId
          ? {
              productId: line.productId,
              quantity: Math.min(MAX_LINE_QUANTITY, line.quantity + 1),
            }
          : line),
      }
    }
    case 'increment':
      if (!state.lines.some(line => line.productId === action.productId)) {
        return {
          lines: [...state.lines],
        }
      }
      return {
        lines: updateLine(
          state.lines,
          action.productId,
          quantity => Math.min(MAX_LINE_QUANTITY, quantity + 1),
        ),
      }
    case 'decrement':
      return {
        lines: updateLine(
          state.lines,
          action.productId,
          quantity => quantity <= 1
            ? null
            : quantity - 1,
        ),
      }
    case 'remove':
      return {
        lines: state.lines.filter(line => line.productId !== action.productId),
      }
    case 'clear':
      return { lines: [] }
    case 'hydrate':
      return {
        lines: action.lines.map(line => ({ ...line })),
      }
  }
}

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
