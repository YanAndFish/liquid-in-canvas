import { afterEach, describe, expect, it, vi } from 'vitest'
import { CssGlassStage, GLASS_CSS_ATTR } from '../../src/css/CssGlassStage'
import {
  createRefractionFilter,
  RefractionFilters,
  refractionMaps,
  refractionSample,
  refractionShape,
  supportsSvgBackdropFilter,
} from '../../src/css/refraction'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { mountLiquidGlass } from '../../src/mount'

function options(attributes: Record<string, string> = {}) {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  return parseGlassOptions(element, 'dark')
}

/** 让 jsdom 看起来像支持把 SVG 滤镜用作背景滤镜的 Chromium。 */
function stubChromium(): void {
  vi.stubGlobal('CSS', {
    supports: (property: string, value: string) => property === 'backdrop-filter' && value.startsWith('url('),
  })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36',
    userAgentData: {
      brands: [
        { brand: 'Chromium' },
      ],
    },
  })
}

/** jsdom 没有二维画布，这里提供只记录像素、不真正绘制的替身。 */
function stubCanvas(): { images: ImageData[] } {
  const images: ImageData[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: ImageData) => {
        images.push({
          ...image,
          data: image.data.slice(),
        })
      },
    } as unknown as CanvasRenderingContext2D
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/png;base64,${images.length}`)
  return { images }
}

/** jsdom 不做布局，这里给元素一个固定的布局尺寸。 */
function sized(width: number, height: number): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-liquid-glass', '')
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    get: () => width,
  })
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    get: () => height,
  })
  return element
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('supportsSvgBackdropFilter', () => {
  it('jsdom 中不支持', () => {
    expect(supportsSvgBackdropFilter()).toBe(false)
  })

  it('只在 Chromium 内核上启用', () => {
    stubChromium()
    expect(supportsSvgBackdropFilter()).toBe(true)
    // 能解析写法但不是 Chromium 内核的浏览器不启用。
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Version/26.0 Safari/605.1.15' })
    expect(supportsSvgBackdropFilter()).toBe(false)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36',
      userAgentData: {
        brands: [
          { brand: 'Not A Brand' },
        ],
      },
    })
    expect(supportsSvgBackdropFilter()).toBe(false)
  })
})

describe('refractionShape', () => {
  it('厚度受短边限制，偏折带不超过短边的一半', () => {
    const wide = refractionShape(options(), 400, 200)!
    const pill = refractionShape(options({ 'data-glass-radius': '999' }), 160, 44)!
    expect(wide.offset).toBeGreaterThan(pill.offset)
    expect(pill.band).toBeLessThanOrEqual(22)
    // 圆角不超过短边的一半。
    expect(pill.radius).toEqual([22, 22, 22, 22])
  })

  it('没有厚度、尺寸过小或过大时不使用滤镜', () => {
    expect(refractionShape(options({ 'data-glass-refraction': '0' }), 200, 60)).toBeNull()
    expect(refractionShape(options(), 4, 60)).toBeNull()
    // 大面板的滤镜开销过高。
    expect(refractionShape(options(), 360, 620)).toBeNull()
  })

  it('小数尺寸取整，避免为同一块玻璃反复生成滤镜', () => {
    expect(refractionShape(options(), 200.4, 59.6)).toEqual(refractionShape(options(), 200, 60))
  })
})

describe('refractionSample', () => {
  const shape = refractionShape(options({ 'data-glass-radius': '20' }), 200, 80)!

  it('中心没有偏移也没有高光', () => {
    const center = refractionSample(shape, 100, 40)
    expect(center.x).toBeCloseTo(0)
    expect(center.y).toBeCloseTo(0)
    expect(center.highlight).toBeCloseTo(0)
  })

  it('直边上的偏移垂直于边并指向内部，越靠近轮廓越大', () => {
    const edge = refractionSample(shape, 0.5, 40)
    const inner = refractionSample(shape, 8, 40)
    expect(edge.x).toBeGreaterThan(0.8)
    expect(edge.y).toBeCloseTo(0)
    expect(inner.x).toBeGreaterThan(0)
    expect(inner.x).toBeLessThan(edge.x)
    // 右边和下边方向相反。
    expect(refractionSample(shape, 199.5, 40).x).toBeLessThan(-0.8)
    expect(refractionSample(shape, 100, 79.5).y).toBeLessThan(-0.8)
  })

  it('圆角处的偏移指向圆心', () => {
    // 左上角圆心在 (20, 20)，取圆弧 45° 方向上的一点。
    const sample = refractionSample(shape, 20 - 13, 20 - 13)
    expect(sample.x).toBeGreaterThan(0)
    expect(sample.x).toBeCloseTo(sample.y)
  })

  it('朝向左上光源的边比背光的边亮', () => {
    const top = refractionSample(shape, 100, 0.5).highlight
    const bottom = refractionSample(shape, 100, 79.5).highlight
    expect(top).toBeGreaterThan(bottom)
    expect(bottom).toBeGreaterThan(0)
  })

  it('轮廓之外没有高光', () => {
    expect(refractionSample(shape, 0.5, 0.5).highlight).toBe(0)
  })
})

describe('折射滤镜', () => {
  it('没有二维画布时不生成滤镜', () => {
    const shape = refractionShape(options(), 200, 60)!
    expect(refractionMaps(shape)).toBeNull()
    expect(createRefractionFilter('f', shape)).toBeNull()
    expect(new RefractionFilters().acquire(shape)).toBeNull()
  })

  it('偏移与高光各用一张灰度贴图', () => {
    const { images } = stubCanvas()
    const maps = refractionMaps(refractionShape(options(), 200, 60)!)!
    expect(maps.shine).not.toBeNull()
    expect(images).toHaveLength(3)
    for (const image of images) {
      // 小控件的贴图是元素的两倍大。
      expect([image.width, image.height]).toEqual([400, 120])
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i] !== image.data[i + 1] || image.data[i] !== image.data[i + 2] || image.data[i + 3] !== 255)
          throw new Error(`pixel ${i / 4} is not opaque gray`)
      }
    }
    // 水平偏移贴图：左边缘大于中性值，右边缘小于中性值，中心为中性值。
    const row = 60 * 400 * 4
    expect(images[0]!.data[row]).toBeGreaterThan(200)
    expect(images[0]!.data[row + 399 * 4]).toBeLessThan(55)
    expect(images[0]!.data[row + 200 * 4]).toBe(128)
  })

  it('没有高光时不生成高光贴图', () => {
    stubCanvas()
    const shape = refractionShape(options({ 'data-glass-specular': '0' }), 200, 60)!
    expect(refractionMaps(shape)!.shine).toBeNull()
    expect(createRefractionFilter('f', shape)!.querySelectorAll('feImage')).toHaveLength(2)
  })

  it('有色散时三个通道分别位移，红蓝偏移量一小一大', () => {
    stubCanvas()
    const filter = createRefractionFilter('f', refractionShape(options({ 'data-glass-dispersion': '0.5' }), 200, 60)!)!
    const scales = [
      ...filter.querySelectorAll('feDisplacementMap'),
    ].map(node => Number(node.getAttribute('scale')))
    expect(scales).toHaveLength(3)
    expect(scales[0]!).toBeLessThan(scales[1]!)
    expect(scales[2]!).toBeGreaterThan(scales[1]!)
  })

  it('没有色散时只位移一次', () => {
    stubCanvas()
    const filter = createRefractionFilter('f', refractionShape(options({ 'data-glass-dispersion': '0' }), 200, 60)!)!
    expect(filter.querySelectorAll('feDisplacementMap')).toHaveLength(1)
  })

  it('相同形状共用一个滤镜，没有使用者后移除', () => {
    stubCanvas()
    const filters = new RefractionFilters()
    const shape = refractionShape(options(), 200, 60)!
    const first = filters.acquire(shape)!
    const second = filters.acquire({ ...shape })!
    expect(second.id).toBe(first.id)
    expect(document.querySelectorAll('filter')).toHaveLength(1)
    filters.release(first.signature)
    expect(document.getElementById(first.id)).not.toBeNull()
    filters.release(first.signature)
    expect(document.getElementById(first.id)).toBeNull()
    filters.dispose()
    expect(document.querySelector('svg')).toBeNull()
  })
})

describe('带折射的回退', () => {
  it('支持时给玻璃套上滤镜并由滤镜绘制高光，停用后清理干净', () => {
    stubChromium()
    stubCanvas()
    const root = document.createElement('div')
    const element = sized(200, 60)
    root.append(element)
    document.body.append(root)
    const stage = new CssGlassStage({ root })
    stage.start()
    expect(stage.refraction).toBe(true)
    expect(element.getAttribute(GLASS_CSS_ATTR)).toBe('svg')
    const reference = element.style.getPropertyValue('--lg-filter')
    expect(reference).toMatch(/^url\(#liquid-glass-refraction-\d+\)$/)
    expect(document.querySelector(reference.slice(4, -1))).not.toBeNull()
    expect(element.style.getPropertyValue('--lg-shadow')).not.toContain('inset')
    stage.dispose()
    expect(element.hasAttribute(GLASS_CSS_ATTR)).toBe(false)
    expect(element.style.getPropertyValue('--lg-filter')).toBe('')
    expect(document.querySelector('filter')).toBeNull()
  })

  it('没有布局尺寸的玻璃只用模糊，高光由内阴影绘制', () => {
    stubChromium()
    stubCanvas()
    const root = document.createElement('div')
    const element = sized(0, 0)
    root.append(element)
    document.body.append(root)
    const stage = new CssGlassStage({ root })
    stage.start()
    expect(element.getAttribute(GLASS_CSS_ATTR)).toBe('')
    expect(element.style.getPropertyValue('--lg-shadow')).toContain('inset')
    stage.dispose()
  })

  it('可以关闭折射，或在不支持的浏览器上自动关闭', () => {
    const root = document.createElement('div')
    root.append(sized(200, 60))
    document.body.append(root)
    expect(new CssGlassStage({ root }).refraction).toBe(false)
    stubChromium()
    expect(new CssGlassStage({ root, refraction: false }).refraction).toBe(false)
  })

  it('挂载时按 svg → css 的顺序选择回退', async () => {
    const root = document.createElement('div')
    root.append(sized(200, 60))
    document.body.append(root)
    // 不支持时请求 svg 得到 css。
    const plain = await mountLiquidGlass({ root, mode: 'svg' })
    expect(plain.mode).toBe('css')
    plain.dispose()

    stubChromium()
    const modes: string[] = []
    const auto = await mountLiquidGlass({
      root,
      beforeStart: (_, mode) => modes.push(mode),
    })
    expect(auto.mode).toBe('svg')
    expect(modes).toEqual(['svg'])
    auto.dispose()
    // 明确指定 css 时不使用滤镜。
    const css = await mountLiquidGlass({ root, mode: 'css' })
    expect(css.mode).toBe('css')
    css.dispose()
  })
})
