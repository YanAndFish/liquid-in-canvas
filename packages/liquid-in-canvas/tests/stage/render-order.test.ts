import { describe, expect, it } from 'vitest'
import { parseOverlayLayer } from '../../src/CanvasOverlay'
import {
  glassContentRenderOrder,
  glassRenderOrder,
  glassVolumeRenderOrder,
  OVERLAY_TOP_LAYER,
  overlayRenderOrder,
  PAGE_RENDER_ORDER,
} from '../../src/render-order'

describe('舞台绘制顺序', () => {
  it('页面快照位于所有玻璃之下', () => {
    expect(PAGE_RENDER_ORDER).toBeLessThan(glassVolumeRenderOrder(-10, 0))
  })

  it('同层内容总在体积组之上，且不越过下一层', () => {
    for (const layer of [0, 1, 10]) {
      expect(glassContentRenderOrder(layer, 0)).toBeGreaterThan(glassVolumeRenderOrder(layer, 1))
      expect(glassContentRenderOrder(layer, 0.999)).toBeLessThan(glassVolumeRenderOrder(layer + 1, 0))
    }
  })

  it('前景层盖住更低各层，被同层及更高层的玻璃盖住', () => {
    for (const layer of [-3, 0, 5]) {
      expect(overlayRenderOrder(layer)).toBeGreaterThan(glassContentRenderOrder(layer - 1, 0.999))
      expect(overlayRenderOrder(layer)).toBeLessThan(glassVolumeRenderOrder(layer, 0))
    }
  })

  it('没有声明层级的前景层位于所有玻璃之上', () => {
    expect(overlayRenderOrder(OVERLAY_TOP_LAYER)).toBeGreaterThan(glassContentRenderOrder(100, 0.999))
    expect(parseOverlayLayer(null)).toBe(OVERLAY_TOP_LAYER)
    expect(parseOverlayLayer('')).toBe(OVERLAY_TOP_LAYER)
    expect(parseOverlayLayer('5')).toBe(5)
    expect(parseOverlayLayer('-500')).toBe(-100)
  })

  it('层级越高越靠前', () => {
    expect(glassRenderOrder(1)).toBeGreaterThan(glassRenderOrder(0))
  })
})
