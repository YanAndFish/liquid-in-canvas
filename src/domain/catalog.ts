import type { Category, CategoryMeta, Product, ProductId } from './types'

export const CATEGORIES: readonly CategoryMeta[] = [
  {
    id: 'living',
    label: { en: 'Living', zh: '家居' },
  },
  {
    id: 'kitchen',
    label: { en: 'Kitchen', zh: '厨房' },
  },
  {
    id: 'daily',
    label: { en: 'Daily', zh: '日用' },
  },
]

export const PRODUCTS: readonly Product[] = [
  {
    id: 'throw-01',
    name: { en: 'Linen Throw', zh: '亚麻盖毯' },
    category: 'living',
    priceCents: 12800,
    blurb: {
      en: 'A washed linen throw that softens with every wash.',
      zh: '水洗亚麻盖毯，越洗越柔软。',
    },
    image: '/products/linen-throw.webp',
  },
  {
    id: 'carafe-02',
    name: { en: 'Stoneware Carafe', zh: '炻器水壶' },
    category: 'kitchen',
    priceCents: 7600,
    blurb: {
      en: 'A hand-thrown carafe with a matte, chalky glaze.',
      zh: '手工拉坯的炻器水壶，哑光粉质釉面。',
    },
    image: '/products/stoneware-carafe.webp',
  },
  {
    id: 'board-03',
    name: { en: 'Oak Board', zh: '橡木砧板' },
    category: 'kitchen',
    priceCents: 5400,
    blurb: {
      en: 'A solid oak board with a hand-rubbed oil finish.',
      zh: '整块橡木，手工涂油，越用越润。',
    },
    image: '/products/oak-board.webp',
  },
  {
    id: 'candle-04',
    name: { en: 'Cedar Candle', zh: '雪松蜡烛' },
    category: 'daily',
    priceCents: 3800,
    blurb: {
      en: 'Cedar, smoke and a little resin. Burns for forty hours.',
      zh: '雪松、烟熏与一点树脂，可燃烧四十小时。',
    },
    image: '/products/cedar-candle.webp',
  },
  {
    id: 'towel-05',
    name: { en: 'Cotton Towel', zh: '棉质浴巾' },
    category: 'daily',
    priceCents: 4200,
    blurb: {
      en: 'Long-staple cotton, woven thick and brushed soft.',
      zh: '长绒棉，厚织磨毛，柔软吸水。',
    },
    image: '/products/cotton-towel.webp',
  },
  {
    id: 'lantern-06',
    name: { en: 'Paper Lantern', zh: '和纸吊灯' },
    category: 'living',
    priceCents: 9600,
    blurb: {
      en: 'A folded paper shade that turns a bulb into weather.',
      zh: '折纸灯罩，把一盏灯泡变成天气。',
    },
    badge: { en: 'New', zh: '新品' },
    image: '/products/paper-lantern.webp',
  },
]

export const PRODUCT_BY_ID: ReadonlyMap<ProductId, Product> = new Map(
  PRODUCTS.map(product => [product.id, product]),
)

export function getProduct(id: string): Product | undefined {
  return PRODUCT_BY_ID.get(id as ProductId)
}

export function isProductId(id: string): id is ProductId {
  return PRODUCT_BY_ID.has(id as ProductId)
}

export function countByCategory(category: Category): number {
  return PRODUCTS.filter(product => product.category === category).length
}
