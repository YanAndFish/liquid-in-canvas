import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { GlassGroups, writePressedBox } from '../../src/liquid-glass/fusion.hot'
import { parseGlassOptions } from '../../src/liquid-glass/options'

const groups = new GlassGroups()

function groupGlassSurfaces(surfaces: VolumeSurface[]): VolumeSurface[][] {
  groups.build(surfaces, surfaces.length)
  return groups.groups.slice(0, groups.count).map(group => group.members.slice(0, group.count))
}

function pressedBox(surface: VolumeSurface): number[] {
  const box = [0, 0, 0, 0]
  writePressedBox(box, 0, surface)
  return box
}

function surface(id: number, left: number, layer = 0, fusion = 32): VolumeSurface {
  return {
    id,
    left,
    top: 0,
    width: 100,
    height: 100,
    clip: [0, 0, 1000, 1000],
    opacity: 1,
    brightness: 1,
    paintOrder: 0,
    press: 0,
    materialize: 1,
    layer,
    host: null,
    fusion,
    options: {
      ...parseGlassOptions(document.createElement('div'), 'light'),
      layer,
      fusion,
    },
  }
}

describe('玻璃层级与融合', () => {
  it('同层表面靠近时形成一个绘制组', () => {
    expect(groupGlassSurfaces([
      surface(1, 0),
      surface(2, 120),
    ]).map(group => group.map(item => item.id))).toEqual([
      [1, 2],
    ])
  })
  it('迁移中的连接只让成对的两块融合，并在这一组里抬高两者的融合距离', () => {
    const source = surface(1, 0, 0, 0)
    const emerging = surface(2, 120, 0, 0)
    const neighbour = surface(3, -130, 0, 32)
    emerging.link = source
    emerging.linkFusion = 24
    expect(groupGlassSurfaces([source, emerging, neighbour]).map(group => group.map(item => item.id))).toEqual([
      [1, 2],
      [3],
    ])
    expect(source.fusion).toBe(24)
    expect(emerging.fusion).toBe(24)
    expect(neighbour.fusion).toBe(32)
  })
  it('连接的融合距离不够跨过间距时不连成一组', () => {
    const source = surface(1, 0, 0, 0)
    const emerging = surface(2, 140, 0, 0)
    emerging.link = source
    emerging.linkFusion = 24
    expect(groupGlassSurfaces([source, emerging])).toHaveLength(2)
    expect(source.fusion).toBe(0)
  })
  it('不同层级的重叠表面分别绘制', () => {
    expect(groupGlassSurfaces([
      surface(1, 0),
      surface(2, 50, 1),
    ])).toHaveLength(2)
  })
  it('关闭融合的表面与邻近表面分别绘制', () => {
    expect(groupGlassSurfaces([
      surface(1, 0, 0, 0),
      surface(2, 80),
    ])).toHaveLength(2)
  })
  it('间接连接的三个表面合并到一组', () => {
    expect(groupGlassSurfaces([
      surface(1, 0),
      surface(3, 240),
      surface(2, 120),
    ]).map(group => group.map(item => item.id))).toEqual([
      [1, 2, 3],
    ])
  })
  it('按压时只略微横向拉伸、纵向压缩，不放大；材质化时从略小的尺寸长出来，中心不变', () => {
    const pressed = {
      ...surface(1, 0),
      press: 1,
    }
    const [cx, cy, hx, hy] = pressedBox(pressed)
    expect([cx, cy]).toEqual([50, 50])
    expect(hx).toBeCloseTo(50.9)
    expect(hy).toBeCloseTo(48.75)
    expect(pressedBox(surface(1, 0))).toEqual([50, 50, 50, 50])
    const appearing = pressedBox({
      ...surface(1, 0),
      materialize: 0,
    })
    expect(appearing[2]).toBeCloseTo(46)
    expect(appearing[3]).toBeCloseTo(46)
  })
  it('拉开距离后连接组拆分', () => {
    const a = surface(1, 0)
    const b = surface(2, 120)
    expect(groupGlassSurfaces([a, b])).toHaveLength(1)
    b.left = 170
    expect(groupGlassSurfaces([a, b])).toHaveLength(2)
  })
  it('属性指定的层级、融合距离与三维高度被解析', () => {
    const element = document.createElement('div')
    element.setAttribute('data-glass-layer', '3')
    element.setAttribute('data-glass-fusion', '48')
    element.setAttribute('data-glass-elevation', '24')
    expect(parseGlassOptions(element, 'light')).toMatchObject({
      layer: 3,
      fusion: 48,
      elevation: 24,
    })
  })
})
