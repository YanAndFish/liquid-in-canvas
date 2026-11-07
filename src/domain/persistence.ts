import type { CartLine, ProductId } from './types'
import { MAX_LINE_QUANTITY } from './cart'
import { isProductId } from './catalog'

export const CART_STORAGE_KEY = 'still.cart.v1'

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function sanitizeLines(raw: unknown): CartLine[] {
  try {
    if (!Array.isArray(raw))
      return []

    const quantities = new Map<ProductId, number>()
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null)
        continue
      const candidate = entry as { productId?: unknown, quantity?: unknown }
      if (typeof candidate.productId !== 'string' || !isProductId(candidate.productId))
        continue
      if (
        typeof candidate.quantity !== 'number'
        || !Number.isInteger(candidate.quantity)
        || candidate.quantity < 1
      ) {
        continue
      }

      const current = quantities.get(candidate.productId)
      const next = Math.min(
        MAX_LINE_QUANTITY,
        (current ?? 0) + candidate.quantity,
      )
      quantities.set(candidate.productId, next)
    }

    return [...quantities].map(([productId, quantity]) => ({ productId, quantity }))
  }
  catch {
    return []
  }
}

export function readCart(storage: StorageLike): CartLine[] {
  try {
    const raw = storage.getItem(CART_STORAGE_KEY)
    if (raw === null)
      return []
    return sanitizeLines(JSON.parse(raw))
  }
  catch {
    return []
  }
}

export function writeCart(storage: StorageLike, lines: readonly CartLine[]): void {
  try {
    storage.setItem(CART_STORAGE_KEY, JSON.stringify(lines))
  }
  catch {

  }
}
