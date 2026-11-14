import type { GlassOptions, GlassRadius } from '../liquid-glass/options'
import { glassEdgeTilt, glassProfile } from '../liquid-glass/profile'

/** 一块玻璃的边缘折射滤镜参数，长度使用 CSS 像素。 */
export interface RefractionShape {
  width: number
  height: number
  radius: GlassRadius
  /** 发生偏折的边缘宽度，即顶面倒角的宽度。 */
  band: number
  /** 顶面倒角的高度。 */
  rise: number
  /** 倒角曲线的超椭圆指数。 */
  curve: number
  /** 轮廓处的最大取样偏移。 */
  offset: number
  /** 红、蓝通道偏移相对绿通道的增减比例，0 表示没有色散。 */
  spread: number
  /** 轮廓高光强度，0 表示没有高光。 */
  specular: number
}

/**
 * 面积（CSS 像素）超过它的玻璃不使用滤镜，只保留模糊。
 *
 * 滤镜的开销与面积成正比，而且背景每变化一帧就要重算一次。实测 DPR 2 下一块 360×620 的面板
 * 会把滚动拖到三十帧以下，导航条和按钮这样的尺寸（十万像素以内）则没有可见的影响。
 */
const MAX_AREA = 120_000
/** 轮廓处的最大偏移由实体半厚度和抬升高度两部分组成：光线在实体内偏折，离开后还要走过抬升的距离。 */
const OFFSET_PER_DEPTH = 1.25
const OFFSET_PER_ELEVATION = 0.5
/** 轮廓高光线的宽度。 */
const RIM_WIDTH = 1.1

/**
 * 当前浏览器能否把 SVG 滤镜用作 `backdrop-filter`。
 *
 * 目前只有 Chromium 内核会绘制。其他内核可能接受这个写法，但整条 `backdrop-filter` 会失效，
 * 连模糊也一起丢掉，所以除了语法检测还要确认内核。
 */
export function supportsSvgBackdropFilter(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || typeof navigator === 'undefined')
    return false
  if (!CSS.supports('backdrop-filter', 'url(#a)'))
    return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands
  return brands
    ? brands.some(entry => entry.brand === 'Chromium')
    : /Chrome\/\d+/.test(navigator.userAgent)
}

/**
 * 由玻璃参数和元素尺寸得到折射滤镜的形状；不需要滤镜时返回 null。
 *
 * 截面的取法与三维实体一致：厚度受控件短边限制，偏折集中在倒角宽度内。
 * 尺寸取整，使滚动或动画中的小数像素不会不断生成新的滤镜。
 */
export function refractionShape(options: GlassOptions, width: number, height: number): RefractionShape | null {
  const w = Math.round(width)
  const h = Math.round(height)
  if (options.refraction <= 0 || w < 8 || h < 8 || w * h > MAX_AREA)
    return null
  const short = Math.min(w, h)
  const profile = glassProfile(options, w, h)
  const depth = profile.halfDepth
  const limit = short / 2
  return {
    width: w,
    height: h,
    radius: options.radius.map(value => Math.round(Math.min(value, limit))) as unknown as GlassRadius,
    band: Math.max(1, Math.round(profile.bevelWidth)),
    rise: Math.round(profile.bevelHeight * 10) / 10,
    curve: Math.round(profile.curve * 100) / 100,
    offset: Math.round(Math.min(depth * OFFSET_PER_DEPTH + options.elevation * OFFSET_PER_ELEVATION, short * 0.45) * 10) / 10,
    spread: Math.round(options.dispersion * 0.25 * 1000) / 1000,
    specular: Math.round(options.specular * 100) / 100,
  }
}

export function refractionSignature(shape: RefractionShape): string {
  return `${shape.width}x${shape.height}r${shape.radius.join(',')}b${shape.band},${shape.rise},${shape.curve}o${shape.offset}s${shape.spread}h${shape.specular}`
}

/** 位移贴图上一个点的取值。 */
export interface RefractionSample {
  /** 取样偏移方向与比例：长度 0–1，指向玻璃内部。 */
  x: number
  y: number
  /** 高光的不透明度，0–1。 */
  highlight: number
}

/** 指向光源的平面方向（左上），与体积着色器的光照方向一致。 */
const LIGHT = [-0.6, -0.8] as const

/**
 * 计算玻璃上一点的偏移与高光。坐标以元素左上角为原点。
 *
 * 用圆角矩形的有向距离得到到轮廓的深度和法线：偏移沿法线指向内部，大小取倒角表面的倾斜程度，
 * 在轮廓处最大，到倒角内侧衰减为零，模拟凸起的倒角把光线折向内部。高光是贴着轮廓的一圈细线，
 * 朝向光源的一侧最亮，背光一侧次之，再加一层很淡的内侧辉光。
 */
export function refractionSample(shape: RefractionShape, px: number, py: number): RefractionSample {
  const halfWidth = shape.width / 2
  const halfHeight = shape.height / 2
  const x = px - halfWidth
  const y = py - halfHeight
  const [tl, tr, br, bl] = shape.radius
  const radius = x < 0
    ? (y < 0
        ? tl
        : bl)
    : (y < 0
        ? tr
        : br)
  const qx = Math.abs(x) - halfWidth + radius
  const qy = Math.abs(y) - halfHeight + radius
  const signX = x < 0
    ? -1
    : 1
  const signY = y < 0
    ? -1
    : 1
  // 轮廓外侧为正的有向距离，以及朝外的单位法线。
  let distance: number
  let normalX: number
  let normalY: number
  if (qx > 0 && qy > 0) {
    const length = Math.hypot(qx, qy)
    distance = length - radius
    normalX = qx / length * signX
    normalY = qy / length * signY
  }
  else if (qx > qy) {
    distance = qx - radius
    normalX = signX
    normalY = 0
  }
  else {
    distance = qy - radius
    normalX = 0
    normalY = signY
  }
  const depth = Math.max(0, -distance)
  const t = Math.min(1, depth / Math.max(shape.band, 1))
  const amount = glassEdgeTilt(depth, shape.band, shape.rise, shape.curve)
  const facing = normalX * LIGHT[0] + normalY * LIGHT[1]
  const lit = Math.max(0, facing)
  const back = Math.max(0, -facing)
  // 轮廓外侧留半个像素的过渡，圆角处不出现锯齿。
  const inside = Math.min(1, Math.max(0, 0.5 - distance))
  const line = Math.exp(-depth / RIM_WIDTH)
  const highlight = shape.specular * inside * (line * (0.2 + 0.62 * lit * lit + 0.3 * back * back * back) + 0.09 * (1 - t) ** 3 * (0.35 + 0.65 * lit))
  return {
    x: -normalX * amount,
    y: -normalY * amount,
    highlight: Math.min(1, highlight),
  }
}

/** 贴图边长相对元素的倍率：小控件用两倍，细高光线在高倍率屏幕上才清晰；大面板用一倍控制体积。 */
function mapScale(shape: RefractionShape): number {
  return shape.width * shape.height * 4 <= 400_000
    ? 2
    : 1
}

/** 一个滤镜用到的三张灰度贴图。 */
export interface RefractionMaps {
  /** 水平偏移，0.5 表示不偏移。 */
  x: string
  /** 垂直偏移，0.5 表示不偏移。 */
  y: string
  /** 高光强度；没有高光时为 null。 */
  shine: string | null
}

/**
 * 逐像素生成贴图并导出为图片。没有二维画布的环境返回 null。
 *
 * 三个量各用一张灰度图，而不是放进同一张图的三个通道：浏览器会把图片从 sRGB 转换到显示器的色彩空间
 * （例如 Display P3）之后再交给滤镜，彩色像素的各通道在转换中相互串扰，红通道的 0.5 不再是 0.5，
 * 整块背景会偏移几个像素，绿通道也会凭空多出一层高光。灰度像素在转换前后保持不变。
 */
export function refractionMaps(shape: RefractionShape): RefractionMaps | null {
  if (typeof document === 'undefined')
    return null
  const scale = mapScale(shape)
  const width = shape.width * scale
  const height = shape.height * scale
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let context: CanvasRenderingContext2D | null = null
  try {
    context = canvas.getContext('2d')
  }
  catch {}
  if (!context)
    return null
  const count = width * height
  const values = [
    new Uint8ClampedArray(count),
    new Uint8ClampedArray(count),
    new Uint8ClampedArray(count),
  ] as const
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const sample = refractionSample(shape, (column + 0.5) / scale, (row + 0.5) / scale)
      const index = row * width + column
      values[0][index] = Math.round(127.5 + sample.x * 127.5)
      values[1][index] = Math.round(127.5 + sample.y * 127.5)
      values[2][index] = Math.round(sample.highlight * 255)
    }
  }
  const image = context.createImageData(width, height)
  const encode = (gray: Uint8ClampedArray): string => {
    for (let i = 0; i < count; i++) {
      const value = gray[i]!
      image.data[i * 4] = value
      image.data[i * 4 + 1] = value
      image.data[i * 4 + 2] = value
      image.data[i * 4 + 3] = 255
    }
    context.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png')
  }
  return {
    x: encode(values[0]),
    y: encode(values[1]),
    shine: shape.specular > 0
      ? encode(values[2])
      : null,
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgElement(name: string, attributes: Record<string, string | number>): SVGElement {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value))
  return element
}

/** 只保留红通道、只保留蓝通道、把灰度变成白色层的不透明度。 */
const KEEP_RED = '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
const KEEP_GREEN = '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'
const KEEP_BLUE = '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
const GRAY_TO_WHITE_ALPHA = '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0'

/**
 * 创建折射滤镜：按位移贴图偏移背景，有色散时红、绿、蓝三个通道使用不同的偏移量，最后叠上轮廓高光。
 *
 * 滤镜接在 `blur()` 之后，偏移的是已经模糊的背景，与体积着色器在折射后的位置取样模糊纹理一致。
 * 无法生成贴图时返回 null。
 */
export function createRefractionFilter(id: string, shape: RefractionShape): SVGElement | null {
  const maps = refractionMaps(shape)
  if (!maps)
    return null
  const { width, height } = shape
  const filter = svgElement('filter', {
    id,
    'x': 0,
    'y': 0,
    width,
    height,
    'filterUnits': 'userSpaceOnUse',
    'primitiveUnits': 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  })
  const image = (href: string, result: string): SVGElement => {
    const element = svgElement('feImage', {
      x: 0,
      y: 0,
      width,
      height,
      preserveAspectRatio: 'none',
      result,
    })
    element.setAttribute('href', href)
    return element
  }
  const matrix = (source: string, values: string, result: string): SVGElement => svgElement('feColorMatrix', {
    in: source,
    type: 'matrix',
    values,
    result,
  })
  const blend = (a: string, b: string, result: string): SVGElement => svgElement('feBlend', {
    in: a,
    in2: b,
    mode: 'screen',
    result,
  })
  // 两张灰度图分别放进红、蓝通道，合成位移滤镜需要的一张图。通道互不重叠，滤色混合等于相加。
  filter.append(
    image(maps.x, 'mx'),
    image(maps.y, 'my'),
    matrix('mx', KEEP_RED, 'mapx'),
    matrix('my', KEEP_BLUE, 'mapy'),
    blend('mapx', 'mapy', 'map'),
  )
  const displace = (scale: number, result: string): SVGElement => svgElement('feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'map',
    scale: Math.round(scale * 100) / 100,
    xChannelSelector: 'R',
    yChannelSelector: 'B',
    result,
  })
  // 贴图取值 0–1 对应 ±scale/2 的偏移。
  const scale = shape.offset * 2
  if (shape.spread <= 0) {
    filter.append(displace(scale, 'displaced'))
  }
  else {
    filter.append(
      displace(scale * (1 - shape.spread), 'dr'),
      matrix('dr', KEEP_RED, 'r'),
      displace(scale, 'dg'),
      matrix('dg', KEEP_GREEN, 'g'),
      displace(scale * (1 + shape.spread), 'db'),
      matrix('db', KEEP_BLUE, 'b'),
      blend('r', 'g', 'rg'),
      blend('rg', 'b', 'displaced'),
    )
  }
  // 位移按整像素取样，背景清晰时会出现台阶，用很小的模糊抹平。
  filter.append(svgElement('feGaussianBlur', {
    in: 'displaced',
    stdDeviation: 0.6,
    edgeMode: 'duplicate',
    result: 'refracted',
  }))
  if (maps.shine) {
    filter.append(
      image(maps.shine, 'ms'),
      matrix('ms', GRAY_TO_WHITE_ALPHA, 'shine'),
      svgElement('feComposite', { in: 'shine', in2: 'refracted', operator: 'over' }),
    )
  }
  return filter
}

/**
 * 页面里的滤镜定义。相同形状的玻璃共用一个滤镜，按引用计数回收。
 */
export class RefractionFilters {
  private host: SVGElement | null = null
  private defs: SVGElement | null = null
  private readonly entries = new Map<string, { id: string, element: SVGElement, users: number }>()
  private serial = 0

  /**
   * 取得形状对应的滤镜并增加一次引用，返回可用于 `url(#…)` 的 id。
   * 无法生成滤镜时返回 null，这块玻璃只使用模糊。
   */
  acquire(shape: RefractionShape): { id: string, signature: string } | null {
    const signature = refractionSignature(shape)
    let entry = this.entries.get(signature)
    if (!entry) {
      const id = `liquid-glass-refraction-${++this.serial}`
      const element = createRefractionFilter(id, shape)
      if (!element)
        return null
      this.ensureDefs().append(element)
      entry = { id, element, users: 0 }
      this.entries.set(signature, entry)
    }
    entry.users++
    return { id: entry.id, signature }
  }

  /** 释放一次引用，没有玻璃使用后移除滤镜。 */
  release(signature: string): void {
    const entry = this.entries.get(signature)
    if (!entry || --entry.users > 0)
      return
    entry.element.remove()
    this.entries.delete(signature)
  }

  dispose(): void {
    this.host?.remove()
    this.host = null
    this.defs = null
    this.entries.clear()
  }

  private ensureDefs(): SVGElement {
    if (this.defs)
      return this.defs
    const host = svgElement('svg', {
      'width': 0,
      'height': 0,
      'aria-hidden': 'true',
      'focusable': 'false',
    })
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
    const defs = svgElement('defs', {})
    host.append(defs)
    document.body.append(host)
    this.host = host
    this.defs = defs
    return defs
  }
}
