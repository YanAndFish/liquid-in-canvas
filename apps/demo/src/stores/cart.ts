import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { StorageLike } from '@/domain/persistence'
import type { CartLine, CartLineItem, CartState, CartTotals, ProductId } from '@/domain/types'
import { computed, inject, readonly, ref } from 'vue'
import { MAX_LINE_QUANTITY, selectLineItems, selectTotals } from '@/domain/cart'
import { readCart, writeCart } from '@/domain/persistence'
import { browserStorage } from '@/shared/storage'

export interface CartStore {
  state: Readonly<Ref<CartState>>
  lines: ComputedRef<CartLineItem[]>
  totals: ComputedRef<CartTotals>
  add: (productId: ProductId) => void
  increment: (productId: ProductId) => void
  decrement: (productId: ProductId) => void
  remove: (productId: ProductId) => void
  clear: () => void
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage === null)
    return null
  if (storage)
    return storage
  return browserStorage()
}

export function createCartStore(options: { storage?: StorageLike | null } = {}): CartStore {
  const storage = resolveStorage(options.storage)
  const initialLines = storage
    ? readCart(storage)
    : []
  const state = ref<CartState>({ lines: initialLines })
  const lines = computed(() => selectLineItems(state.value))
  const totals = computed(() => selectTotals(state.value))

  function commit(next: readonly CartLine[]): void {
    state.value = { lines: next }
    if (storage)
      writeCart(storage, next)
  }

  function increment(productId: ProductId): void {
    commit(state.value.lines.map(line => line.productId === productId
      ? {
          productId,
          quantity: Math.min(MAX_LINE_QUANTITY, line.quantity + 1),
        }
      : line))
  }

  function add(productId: ProductId): void {
    if (!state.value.lines.some(line => line.productId === productId)) {
      commit([
        ...state.value.lines,
        { productId, quantity: 1 },
      ])
      return
    }
    increment(productId)
  }

  function decrement(productId: ProductId): void {
    commit(state.value.lines.flatMap((line) => {
      if (line.productId !== productId)
        return [line]
      return line.quantity <= 1
        ? []
        : [
            { productId, quantity: line.quantity - 1 },
          ]
    }))
  }

  function remove(productId: ProductId): void {
    commit(state.value.lines.filter(line => line.productId !== productId))
  }

  function clear(): void {
    commit([])
  }

  return {
    state: readonly(state),
    lines,
    totals,
    add,
    increment,
    decrement,
    remove,
    clear,
  }
}

export const CART_KEY: InjectionKey<CartStore> = Symbol('cart')

export function useCart(): CartStore {
  const cart = inject(CART_KEY)
  if (!cart)
    throw new Error('useCart requires a cart provider with CART_KEY')
  return cart
}
