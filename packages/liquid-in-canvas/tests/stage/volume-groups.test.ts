import type { BackdropBlur } from '../../src/liquid-glass/blur.hot'
import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups, VolumePlanner, writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups.hot'
import { glassVolumeRenderOrder } from '../../src/render-order'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 创建一块独立玻璃，水平位置决定是否与其他玻璃相连。 */
function surface(id: number, left: number, attributes: Record<string, string> = {}): VolumeSurface {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  const options = parseGlassOptions(element, 'light')
  return {
    id,
    left,
    top: 0,
    width: 100,
    height: 100,
    layer: options.layer,
    host: null,
    clip: [0, 0, 1000, 1000],
    opacity: 1,
    brightness: 1,
    paintOrder: 0,
    press: 0,
    options,
    fusion: options.fusion,
  }
}

const SHADING = {
  scale: 1,
  pixelWidth: 2000,
  pixelHeight: 1200,
  cssWidth: 1000,
  cssHeight: 600,
  split: Infinity,
}

function setup() {
  const fake = createFakeGpu()
  const blur = {
    views: [{}, {}, {}, {}, {}],
    generation: 0,
  } as unknown as BackdropBlur
  const groups = new VolumeGroups(fake.gpu, blur)
  const list = new DrawList()
  /** 画一帧，返回画布遍里的绘制项。 */
  const frame = (surfaces: VolumeSurface[], shading = SHADING) => {
    fake.gpu.frame.begin()
    list.reset()
    groups.plan(surfaces, surfaces.length, {} as GPUTextureView, shading, list)
    return list.items.slice(0, list.count).map(item => ({ ...item }))
  }
  const labels = () => fake.pipelines.map(pipeline => String(pipeline.label))
  return { ...fake, frame, labels }
}

describe('三维玻璃组', () => {
  it('成员变化时复用同等数量的管线', () => {
    const { frame, labels } = setup()
    const first = frame([
      surface(1, 0),
      surface(2, 400),
    ])
    expect(first).toHaveLength(2)
    expect(labels()).toEqual(['volume:0:1'])

    // 滚动后换成另外两块独立玻璃，不再创建管线。
    const second = frame([
      surface(5, 0),
      surface(9, 400),
    ])
    expect(second.map(item => item.pipeline)).toEqual(first.map(item => item.pipeline))
    expect(labels()).toEqual(['volume:0:1'])

    // 两块相连后只用一组，按两名成员取用一条新管线；之后再分开、再相连时直接复用。
    expect(frame([
      surface(5, 0),
      surface(9, 110),
    ])).toHaveLength(1)
    frame([
      surface(7, 0),
      surface(8, 400),
    ])
    frame([
      surface(3, 0),
      surface(4, 110),
    ])
    expect(labels()).toEqual(['volume:0:1', 'volume:0:2'])
  })

  it('低分辨率着色画进离屏目标，再用互不重叠的分块合成', () => {
    const { frame, labels } = setup()
    const items = frame([
      surface(1, 0),
      surface(2, 60),
    ], { ...SHADING, scale: 0.5 })
    expect(labels()).toContain('volume:1:2')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => String((item.pipeline as unknown as { label: string }).label) === 'blit:screen:0')).toBe(true)
  })

  it('同层邻近的玻璃合成一组，其余各自成组', () => {
    const planner = new VolumePlanner()
    const surfaces = [
      surface(1, 0),
      surface(2, 110),
      surface(3, 400),
      surface(4, 120, { 'data-glass-layer': '1' }),
    ]
    planner.build(surfaces, surfaces.length, 1000, 600)
    const plans = planner.plans.slice(0, planner.count)
    expect(plans.map(plan => plan.members.slice(0, plan.count).map(member => member.id))).toEqual([
      [1, 2],
      [3],
      [4],
    ])
    expect(plans[2]!.order).toBeGreaterThan(plans[0]!.order)
    expect(plans[2]!.order).toBe(glassVolumeRenderOrder(1, 0))
    // 包围矩形包含融合与阴影的余量，并裁剪到视口之内。
    expect(plans[0]!.bounds.left).toBe(0)
    expect(plans[0]!.bounds.right).toBeGreaterThan(210)
  })

  it('外层与 HTML 里更靠后的玻璃融合后，嵌套玻璃仍画在外层所在组之后', () => {
    const planner = new VolumePlanner()
    const bar = {
      ...surface(1, 0),
      width: 300,
      paintOrder: 0.1,
    }
    const tab = {
      ...surface(2, 10),
      width: 80,
      host: 1,
      paintOrder: 0.2,
    }
    const button = {
      ...surface(3, 310),
      paintOrder: 0.8,
    }
    const surfaces = [bar, tab, button]
    planner.build(surfaces, surfaces.length, 1000, 600)
    const plans = planner.plans.slice(0, planner.count)
    const ids = plans.map(plan => plan.members.slice(0, plan.count).map(member => member.id))
    expect(ids).toEqual([
      [1, 3],
      [2],
    ])
    expect(plans[1]!.order).toBeGreaterThan(plans[0]!.order)
    expect(plans[1]!.order).toBeLessThan(glassVolumeRenderOrder(1, 0))
  })

  it('uniform 按着色器的成员布局写入', () => {
    const planner = new VolumePlanner()
    planner.build([
      surface(1, 0, { 'data-glass-tint': '#ffffff', 'data-glass-tint-alpha': '0.5', 'data-glass-lens': '0.3' }),
    ], 1, 1000, 600)
    const data = new Float32Array(HEADER_FLOATS + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS)
    writeVolumeGroup(data, 0, planner.plans[0]!)
    const member = VOLUME_GROUP_FLOATS
    expect([
      ...data.slice(member, member + 4),
    ]).toEqual([50, 50, 50, 50])
    expect(data[member + 11]).toBeCloseTo(0.3)
    // 白色染色乘染色比例，在线性空间中为 0.5。
    expect(data[member + 20]).toBeCloseTo(0.5)
    expect(data[member + 23]).toBe(1)
    // 截面：半厚度 24 时倒角宽高都是 0.68 倍，三次超椭圆，上下对称。
    expect(data[member + 8]).toBe(24)
    expect(data[member + 24]).toBeCloseTo(16.32)
    expect(data[member + 25]).toBeCloseTo(16.32)
    expect(data[member + 26]).toBe(3)
    expect(data[member + 27]).toBe(1)
  })
})
