export type Locale = 'en' | 'zh'

export type LocalizedText = Record<Locale, string>

export type Category = 'living' | 'kitchen' | 'daily'

export interface CategoryMeta {
  id: Category
  label: LocalizedText
}

export type ProductId
  = | 'throw-01'
    | 'carafe-02'
    | 'board-03'
    | 'candle-04'
    | 'towel-05'
    | 'lantern-06'
    | 'cushion-07'
    | 'vase-08'
    | 'mug-09'
    | 'servers-10'
    | 'soap-11'
    | 'brush-12'

export type ProductSlug
  = | 'linen-throw'
    | 'stoneware-carafe'
    | 'cedar-candle'
    | 'wool-cushion'
    | 'oak-board'
    | 'cotton-towel'
    | 'ceramic-vase'
    | 'enamel-mug'
    | 'cedar-soap'
    | 'paper-lantern'
    | 'walnut-servers'
    | 'bath-brush'

export interface ProductSpecs {
  material: LocalizedText
  dimensions: LocalizedText
  care: LocalizedText
}

export interface Product {
  id: ProductId
  slug: ProductSlug
  name: LocalizedText
  category: Category
  priceCents: number
  blurb: LocalizedText
  details: LocalizedText
  specs: ProductSpecs
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
