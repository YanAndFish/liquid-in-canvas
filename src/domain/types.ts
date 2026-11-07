export type Locale = 'en' | 'zh'

export type LocalizedText = Record<Locale, string>

export type Category = 'living' | 'kitchen' | 'daily'

export interface CategoryMeta {
  id: Category
  label: LocalizedText
}

export type ProductId = 'throw-01' | 'carafe-02' | 'board-03' | 'candle-04' | 'towel-05' | 'lantern-06'

export interface Product {
  id: ProductId
  name: LocalizedText
  category: Category
  priceCents: number
  blurb: LocalizedText
  badge?: LocalizedText
  image: string
}

export interface CartLine {
  productId: ProductId
  quantity: number
}

export interface CartState {
  readonly lines: readonly CartLine[]
}

export interface CartLineItem {
  product: Product
  quantity: number
  lineTotalCents: number
}

export interface CartTotals {
  itemCount: number
  subtotalCents: number
  shippingCents: number
  totalCents: number
  remainingForFreeShippingCents: number
  freeShipping: boolean
}

export type CartAction
  = | { type: 'add', productId: ProductId }
    | { type: 'increment', productId: ProductId }
    | { type: 'decrement', productId: ProductId }
    | { type: 'remove', productId: ProductId }
    | { type: 'clear' }
    | { type: 'hydrate', lines: readonly CartLine[] }
