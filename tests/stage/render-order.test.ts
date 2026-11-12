import { describe, expect, it } from 'vitest'
import {
  glassContentRenderOrder,
  glassRenderOrder,
  glassVolumeRenderOrder,
  OVERLAY_RENDER_ORDER,
  PAGE_RENDER_ORDER,
} from '@/stage/render-order'

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

  it('商品动画前景位于导航玻璃之上、购物袋之下', () => {
    expect(OVERLAY_RENDER_ORDER).toBeGreaterThan(glassContentRenderOrder(0, 0.999))
    expect(OVERLAY_RENDER_ORDER).toBeLessThan(glassVolumeRenderOrder(10, 0))
  })

  it('层级越高越靠前', () => {
    expect(glassRenderOrder(1)).toBeGreaterThan(glassRenderOrder(0))
  })
})
