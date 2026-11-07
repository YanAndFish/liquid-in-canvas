import type { Category, CategoryMeta, Product, ProductId, ProductSlug } from './types'

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
    slug: 'linen-throw',
    name: { en: 'Linen Throw', zh: '亚麻盖毯' },
    category: 'living',
    priceCents: 12800,
    blurb: {
      en: 'A washed linen throw that softens with every wash.',
      zh: '水洗亚麻盖毯，越洗越柔软。',
    },
    details: {
      en: 'Washed twice before it leaves the workshop, this throw has the loose, lived-in drape of linen that has already found its place. The weight is generous enough for a sofa but light enough to fold.',
      zh: '出厂前经过两次水洗，垂感松弛，像已经在家中用过很久。分量足够盖住沙发，也轻到可以随手折叠。',
    },
    specs: {
      material: { en: '100% washed European linen', zh: '100% 欧洲水洗亚麻' },
      dimensions: { en: '130 × 180 cm', zh: '130 × 180 厘米' },
      care: { en: 'Machine wash cold. Line dry.', zh: '冷水机洗，悬挂晾干。' },
    },
    image: '/products/linen-throw.webp',
  },
  {
    id: 'carafe-02',
    slug: 'stoneware-carafe',
    name: { en: 'Stoneware Carafe', zh: '炻器水壶' },
    category: 'kitchen',
    priceCents: 7600,
    blurb: {
      en: 'A hand-thrown carafe with a matte, chalky glaze.',
      zh: '手工拉坯的炻器水壶，哑光粉质釉面。',
    },
    details: {
      en: 'Thrown on the wheel and glazed in a chalky sage, each carafe carries the faint ridges of the maker\'s fingers. The handle is pulled by hand, so no two sit the same way.',
      zh: '手工拉坯，施粉质鼠尾草釉，瓶身留着制作者指节的浅浅起伏。把手逐个手拉，因此每一只都不完全相同。',
    },
    specs: {
      material: { en: 'High-fired stoneware', zh: '高温炻器' },
      dimensions: { en: '1 L, 22 cm tall', zh: '1 升，高 22 厘米' },
      care: { en: 'Dishwasher safe. Avoid thermal shock.', zh: '可用洗碗机，避免骤冷骤热。' },
    },
    image: '/products/stoneware-carafe.webp',
  },
  {
    id: 'candle-04',
    slug: 'cedar-candle',
    name: { en: 'Cedar Candle', zh: '雪松蜡烛' },
    category: 'daily',
    priceCents: 3800,
    blurb: {
      en: 'Cedar, smoke and a little resin. Burns for forty hours.',
      zh: '雪松、烟熏与一点树脂，可燃烧四十小时。',
    },
    details: {
      en: 'Cedar, smoke and a little resin, poured into an amber glass vessel. The cotton wick burns clean for about forty hours, then the jar becomes a small vase.',
      zh: '雪松、烟熏与一点树脂，灌入琥珀色玻璃杯。棉芯可稳定燃烧约四十小时，之后杯子还能当作小花器。',
    },
    specs: {
      material: { en: 'Soy wax, cedar and fir balsam', zh: '大豆蜡、雪松与冷杉香脂' },
      dimensions: { en: '220 g, 8 cm tall', zh: '220 克，高 8 厘米' },
      care: { en: 'Trim the wick to 5 mm before each burn.', zh: '每次点燃前将烛芯修剪至 5 毫米。' },
    },
    image: '/products/cedar-candle.webp',
  },
  {
    id: 'cushion-07',
    slug: 'wool-cushion',
    name: { en: 'Wool Cushion', zh: '羊毛靠垫' },
    category: 'living',
    priceCents: 8800,
    blurb: {
      en: 'A dense wool cushion with a hidden zip and a soft, matte hand.',
      zh: '高密度羊毛靠垫，隐形拉链，手感柔软哑光。',
    },
    details: {
      en: 'A firm feather-and-fibre fill holds the shape, while the wool cover stays matte and slightly rough to the touch. The zip is hidden along the lower edge.',
      zh: '羽毛与纤维混合填充，支撑感扎实。羊毛外套呈哑光质感，触手略带颗粒。拉链藏在下缘。',
    },
    specs: {
      material: { en: 'Wool cover, feather and fibre fill', zh: '羊毛外套，羽毛与纤维填充' },
      dimensions: { en: '50 × 50 cm', zh: '50 × 50 厘米' },
      care: { en: 'Spot clean or dry clean.', zh: '局部清洁或干洗。' },
    },
    image: '/products/wool-cushion.webp',
  },
  {
    id: 'board-03',
    slug: 'oak-board',
    name: { en: 'Oak Board', zh: '橡木砧板' },
    category: 'kitchen',
    priceCents: 5400,
    blurb: {
      en: 'A solid oak board with a hand-rubbed oil finish.',
      zh: '整块橡木，手工涂油，越用越润。',
    },
    details: {
      en: 'Cut from a single piece of European oak, with a hand-rubbed oil finish that darkens where it is used. One side is flat for slicing, the other has a shallow juice groove.',
      zh: '整块欧洲橡木切割，手工涂油，常用之处会慢慢变深。一面平整适合切配，另一面留有浅导汁槽。',
    },
    specs: {
      material: { en: 'Solid European oak, food-safe oil', zh: '整块欧洲橡木，食品级木蜡油' },
      dimensions: { en: '42 × 24 × 2.5 cm', zh: '42 × 24 × 2.5 厘米' },
      care: { en: 'Hand wash and oil monthly.', zh: '手洗，每月上一次油。' },
    },
    image: '/products/oak-board.webp',
  },
  {
    id: 'towel-05',
    slug: 'cotton-towel',
    name: { en: 'Cotton Towel', zh: '棉质浴巾' },
    category: 'daily',
    priceCents: 4200,
    blurb: {
      en: 'Long-staple cotton, woven thick and brushed soft.',
      zh: '长绒棉，厚织磨毛，柔软吸水。',
    },
    details: {
      en: 'Long-staple cotton woven to a heavy 600 gsm, then brushed on both sides. It absorbs quickly and gets softer with every wash.',
      zh: '长绒棉织成 600 克重，双面磨毛。吸水快，也会随着每一次清洗变得更柔软。',
    },
    specs: {
      material: { en: '100% long-staple cotton', zh: '100% 长绒棉' },
      dimensions: { en: '70 × 140 cm', zh: '70 × 140 厘米' },
      care: { en: 'Machine wash warm. Tumble dry low.', zh: '温水机洗，低温烘干。' },
    },
    image: '/products/cotton-towel.webp',
  },
  {
    id: 'vase-08',
    slug: 'ceramic-vase',
    name: { en: 'Ceramic Vase', zh: '陶瓷花瓶' },
    category: 'living',
    priceCents: 11200,
    blurb: {
      en: 'A wheel-thrown vase with a chalk glaze and an uneven lip.',
      zh: '手工拉坯花瓶，粉质釉面，口沿自然不齐。',
    },
    details: {
      en: 'A wide belly and a narrow, uneven lip make this vase forgiving of a loose bunch of stems. The chalk glaze stops just short of the foot, leaving a raw clay line.',
      zh: '宽腹、窄口，口沿微微不齐，随手插一把花也好看。粉质釉在圈足上方停住，留出一圈素坯。',
    },
    specs: {
      material: { en: 'Wheel-thrown stoneware', zh: '手工拉坯炻器' },
      dimensions: { en: '24 cm tall, 14 cm wide', zh: '高 24 厘米，宽 14 厘米' },
      care: { en: 'Hand wash.', zh: '手洗。' },
    },
    image: '/products/ceramic-vase.webp',
  },
  {
    id: 'mug-09',
    slug: 'enamel-mug',
    name: { en: 'Enamel Mug', zh: '搪瓷杯' },
    category: 'kitchen',
    priceCents: 3200,
    blurb: {
      en: 'A speckled enamel mug that takes heat and keeps it.',
      zh: '斑点搪瓷杯，耐热，也留得住温度。',
    },
    details: {
      en: 'A speckled enamel finish over steel, with a dark rim and a handle that fits a whole hand. It is happy on a campfire and just as happy at a desk.',
      zh: '钢胎外覆斑点搪瓷，深色口沿，把手刚好容下一整只手。可以上营地火，也适合放在书桌上。',
    },
    specs: {
      material: { en: 'Enamelled steel', zh: '搪瓷钢' },
      dimensions: { en: '350 ml', zh: '350 毫升' },
      care: { en: 'Hand wash. Do not microwave.', zh: '手洗，不可微波。' },
    },
    image: '/products/enamel-mug.webp',
  },
  {
    id: 'soap-11',
    slug: 'cedar-soap',
    name: { en: 'Cedar Soap', zh: '雪松皂' },
    category: 'daily',
    priceCents: 1800,
    blurb: {
      en: 'A cold-process soap with cedar and oat, wrapped in paper.',
      zh: '冷制法雪松燕麦皂，纸包装。',
    },
    details: {
      en: 'Cold-processed with cedarwood, oat and a little shea, then cut and wrapped in unbleached paper. The bar cures for six weeks before it is sold.',
      zh: '冷制法制作，加入雪松、燕麦与少量乳木果脂，切块后用未漂白纸包好。皂体静置熟成六周后出售。',
    },
    specs: {
      material: { en: 'Olive oil, coconut oil, shea, cedarwood', zh: '橄榄油、椰子油、乳木果脂、雪松' },
      dimensions: { en: '120 g', zh: '120 克' },
      care: { en: 'Keep dry between uses.', zh: '使用之间保持干燥。' },
    },
    image: '/products/cedar-soap.webp',
  },
  {
    id: 'lantern-06',
    slug: 'paper-lantern',
    name: { en: 'Paper Lantern', zh: '和纸吊灯' },
    category: 'living',
    priceCents: 9600,
    blurb: {
      en: 'A folded paper shade that turns a bulb into weather.',
      zh: '折纸灯罩，把一盏灯泡变成天气。',
    },
    details: {
      en: 'Folded rice paper over a thin bamboo frame, with a warm dimmable bulb inside. The shade diffuses light into a soft, even glow and casts a faint ribbed shadow on the wall.',
      zh: '薄竹架外覆折叠和纸，内配可调光暖灯泡。灯罩把光揉成柔和均匀的一团，也在墙上留下浅浅的棱纹阴影。',
    },
    specs: {
      material: { en: 'Rice paper, bamboo, steel', zh: '和纸、竹、钢' },
      dimensions: { en: '32 cm diameter, 2.5 m cord', zh: '直径 32 厘米，线长 2.5 米' },
      care: { en: 'Dust with a soft brush. Keep dry.', zh: '软刷除尘，保持干燥。' },
    },
    badge: { en: 'New', zh: '新品' },
    image: '/products/paper-lantern.webp',
  },
  {
    id: 'servers-10',
    slug: 'walnut-servers',
    name: { en: 'Walnut Servers', zh: '胡桃木餐具' },
    category: 'kitchen',
    priceCents: 4600,
    blurb: {
      en: 'A pair of hand-carved walnut servers, oiled and ready.',
      zh: '一对手工雕刻胡桃木餐具，已上油。',
    },
    details: {
      en: 'Carved from a single length of black walnut, then sanded through four grits and oiled. The wide spoon and flat fork are light enough for daily use.',
      zh: '整段黑胡桃木雕刻，经四道砂纸打磨后上油。宽勺与平叉都很轻，适合每天使用。',
    },
    specs: {
      material: { en: 'Black walnut, food-safe oil', zh: '黑胡桃木，食品级木蜡油' },
      dimensions: { en: '30 cm long, pair', zh: '长 30 厘米，一对' },
      care: { en: 'Hand wash and oil occasionally.', zh: '手洗，偶尔上油。' },
    },
    image: '/products/walnut-servers.webp',
  },
  {
    id: 'brush-12',
    slug: 'bath-brush',
    name: { en: 'Bath Brush', zh: '浴刷' },
    category: 'daily',
    priceCents: 3400,
    blurb: {
      en: 'A beechwood bath brush with a long handle and soft bristles.',
      zh: '山毛榉长柄浴刷，刷毛柔软。',
    },
    details: {
      en: 'A long beech handle reaches the middle of the back without effort. The bristles are soft enough for daily use, and the head unscrews for cleaning.',
      zh: '山毛榉长柄轻松够到后背中间。刷毛柔软，适合每天使用，刷头可以拧下清洗。',
    },
    specs: {
      material: { en: 'Beechwood, natural bristle', zh: '山毛榉，天然刷毛' },
      dimensions: { en: '38 cm long', zh: '长 38 厘米' },
      care: { en: 'Rinse and air dry bristles down.', zh: '冲洗后刷毛朝下晾干。' },
    },
    image: '/products/bath-brush.webp',
  },
]

export const PRODUCT_BY_ID: ReadonlyMap<ProductId, Product> = new Map(
  PRODUCTS.map(product => [product.id, product]),
)

export const PRODUCT_BY_SLUG: ReadonlyMap<ProductSlug, Product> = new Map(
  PRODUCTS.map(product => [product.slug, product]),
)

export const CATEGORY_BY_ID = new Map(CATEGORIES.map(category => [category.id, category]))

export function getProduct(id: string): Product | undefined {
  return PRODUCT_BY_ID.get(id as ProductId)
}

export function getProductBySlug(slug: string): Product | undefined {
  return PRODUCT_BY_SLUG.get(slug as ProductSlug)
}

export function isProductId(id: string): id is ProductId {
  return PRODUCT_BY_ID.has(id as ProductId)
}

export function countByCategory(category: Category): number {
  return PRODUCTS.filter(product => product.category === category).length
}
