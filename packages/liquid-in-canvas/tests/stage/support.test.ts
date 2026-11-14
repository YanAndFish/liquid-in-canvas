import { describe, expect, it } from 'vitest'
import { detectStageSupport } from '../../src/support'

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.39 Safari/537.36'
const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Electron/44.0.0 Chrome/152.0.8103.39 Safari/537.36'

function probe(options: { content?: 'fallback' | 'drawable', paint?: boolean, geometry?: boolean } = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.content = options.content ?? 'drawable'
  if (options.paint !== false)
    canvas.requestPaint = () => {}
  if (options.geometry !== false)
    canvas.updateElementGeometry = () => {}
  return canvas
}

const queue = {
  drawElementImageToTexture() {},
}

describe('detectStageSupport', () => {
  it('reports supported when every capability is present', () => {
    const support = detectStageSupport({
      createProbe: () => probe(),
      userAgent: CHROME_UA,
      webgpu: true,
      gpuQueue: queue,
    })

    expect(support.supported).toBe(true)
    expect(support.missing).toEqual([])
    expect(support.report).toEqual({
      htmlInCanvas: true,
      webgpu: true,
      drawElementImageToTexture: true,
      browser: 'Chrome 157',
    })
  })

  it('reports each missing capability in order', () => {
    const support = detectStageSupport({
      createProbe: () => probe({ content: 'fallback', paint: false, geometry: false }),
      userAgent: CHROME_UA,
      webgpu: false,
      gpuQueue: null,
    })

    expect(support.supported).toBe(false)
    expect(support.missing).toEqual([
      'html-in-canvas',
      'webgpu',
      'draw-element-image-to-texture',
    ])
  })

  it('reports html-in-canvas when the probe lacks the drawable API', () => {
    const support = detectStageSupport({
      createProbe: () => probe({ paint: false }),
      userAgent: CHROME_UA,
      webgpu: true,
      gpuQueue: queue,
    })

    expect(support.supported).toBe(false)
    expect(support.missing).toEqual(['html-in-canvas'])
  })

  it('reports webgpu when navigator.gpu is absent', () => {
    const support = detectStageSupport({
      createProbe: () => probe(),
      userAgent: CHROME_UA,
      webgpu: false,
      gpuQueue: queue,
    })

    expect(support.supported).toBe(false)
    expect(support.missing).toEqual(['webgpu'])
  })

  it('reports element upload when the queue lacks drawElementImageToTexture', () => {
    const support = detectStageSupport({
      createProbe: () => probe(),
      userAgent: CHROME_UA,
      webgpu: true,
      gpuQueue: null,
    })

    expect(support.supported).toBe(false)
    expect(support.missing).toEqual(['draw-element-image-to-texture'])
  })

  it('labels Chrome and Electron browsers', () => {
    expect(detectStageSupport({ userAgent: CHROME_UA }).report.browser).toBe('Chrome 157')
    expect(detectStageSupport({ userAgent: ELECTRON_UA }).report.browser).toBe('Electron 44 · Chromium 152')
  })
})
