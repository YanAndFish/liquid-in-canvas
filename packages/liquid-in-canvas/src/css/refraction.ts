import type { GlassOptions, GlassRadius } from '../liquid-glass/options'
import { BASE_IOR, glassEdgeTilt, glassProfile } from '../liquid-glass/profile'

export interface RefractionShape {
  width: number
  height: number
  radius: GlassRadius
  band: number
  rise: number
  curve: number
  offset: number
  spread: number
  specular: number
}

const MAX_AREA = 120_000
const OFFSET_PER_DEPTH = 1.25
const OFFSET_PER_ELEVATION = 0.5
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
    offset: Math.round(Math.min((depth * OFFSET_PER_DEPTH + options.elevation * OFFSET_PER_ELEVATION) * (options.ior - 1) / (BASE_IOR - 1), short * 0.45) * 10) / 10,
    spread: Math.round(options.dispersion * 0.25 * 1000) / 1000,
    specular: Math.round(options.specular * 100) / 100,
  }
}

export function refractionSignature(shape: RefractionShape): string {
  return `${shape.width}x${shape.height}r${shape.radius.join(',')}b${shape.band},${shape.rise},${shape.curve}o${shape.offset}s${shape.spread}h${shape.specular}`
}

export interface RefractionSample {
  x: number
  y: number
  highlight: number
}

const LIGHT = [-0.6, -0.8] as const

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
  const narrow = Math.min(halfWidth, halfHeight)
  const bevel = Math.min(shape.band, narrow)
  const rounding = Math.max(Math.min(radius, bevel - radius, narrow - bevel), 0)
  const shift = radius - rounding
  let distance: number
  let normalX: number
  let normalY: number
  if (qx > 0 && qy > 0) {
    const length = Math.hypot(qx, qy)
    distance = length - radius
    normalX = qx / length
    normalY = qy / length
  }
  else if (qx > qy) {
    distance = qx - radius
    normalX = 1
    normalY = 0
  }
  else {
    distance = qy - radius
    normalX = 0
    normalY = 1
  }
  if (rounding > 0 && distance < -shift) {
    const e = qx - qy
    const deeper = Math.abs(e) < rounding
      ? 0.5 * (Math.sqrt(Math.max(2 * rounding * rounding - e * e, 0)) - qx - qy)
      : rounding - Math.max(qx, qy)
    const nx = Math.max(qx + deeper, 0)
    const ny = Math.max(qy + deeper, 0)
    const length = Math.max(Math.hypot(nx, ny), 0.00001)
    distance = -(shift + deeper)
    normalX = nx / length
    normalY = ny / length
  }
  normalX *= signX
  normalY *= signY
  const depth = Math.max(0, -distance)
  const t = Math.min(1, depth / Math.max(shape.band, 1))
  const amount = glassEdgeTilt(depth, shape.band, shape.rise, shape.curve)
  const facing = normalX * LIGHT[0] + normalY * LIGHT[1]
  const lit = Math.max(0, facing)
  const back = Math.max(0, -facing)
  const inside = Math.min(1, Math.max(0, 0.5 - distance))
  const line = Math.exp(-depth / RIM_WIDTH)
  const highlight = shape.specular * inside * (line * (0.2 + 0.62 * lit * lit + 0.3 * back * back * back) + 0.09 * (1 - t) ** 3 * (0.35 + 0.65 * lit))
  return {
    x: -normalX * amount,
    y: -normalY * amount,
    highlight: Math.min(1, highlight),
  }
}

function mapScale(shape: RefractionShape): number {
  return shape.width * shape.height * 4 <= 400_000
    ? 2
    : 1
}

export interface RefractionMaps {
  x: string
  y: string
  shine: string | null
}

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

const KEEP_RED = '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'
const KEEP_GREEN = '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'
const KEEP_BLUE = '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
const GRAY_TO_WHITE_ALPHA = '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0'

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
  if (maps.shine) {
    filter.append(
      image(maps.shine, 'ms'),
      matrix('ms', GRAY_TO_WHITE_ALPHA, 'shine'),
      svgElement('feComposite', { in: 'shine', in2: 'displaced', operator: 'over' }),
    )
  }
  return filter
}

export class RefractionFilters {
  private host: SVGElement | null = null
  private defs: SVGElement | null = null
  private readonly entries = new Map<string, { id: string, element: SVGElement, users: number }>()
  private serial = 0

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
