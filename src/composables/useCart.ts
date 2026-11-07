import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { StorageLike } from '@/domain/persistence'
import type { CartAction, CartLineItem, CartState, CartTotals } from '@/domain/types'
import { computed, inject, readonly, ref } from 'vue'
import { cartReducer, selectLineItems, selectTotals } from '@/domain/cart'
import { readCart, writeCart } from '@/domain/persistence'

export interface CartStore {
  state: Readonly<Ref<CartState>>
  lines: ComputedRef<CartLineItem[]>
  totals: ComputedRef<CartTotals>
  dispatch: (action: CartAction) => void
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined'
      ? window.localStorage
      : null
  }
  catch {
    return null
  }
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage === null)
    return null
  if (storage)
    return storage
  return defaultStorage()
}

export function createCartStore(options: { storage?: StorageLike | null } = {}): CartStore {
  const storage = resolveStorage(options.storage)
  const initialLines = storage
    ? readCart(storage)
    : []
  const state = ref<CartState>({ lines: initialLines })
  const lines = computed(() => selectLineItems(state.value))
  const totals = computed(() => selectTotals(state.value))

  const dispatch = (action: CartAction): void => {
    const next = cartReducer(state.value, action)
    state.value = next
    if (storage)
      writeCart(storage, next.lines)
  }

  return {
    state: readonly(state),
    lines,
    totals,
    dispatch,
  }
}

export const CART_KEY: InjectionKey<CartStore> = Symbol('cart')

export function useCart(): CartStore {
  const cart = inject(CART_KEY)
  if (!cart)
    throw new Error('useCart requires a cart provider with CART_KEY')
  return cart
}
