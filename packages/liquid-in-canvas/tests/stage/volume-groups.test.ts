import type { BackdropBlur } from '../../src/liquid-glass/blur'
import type { VolumeSurface } from '../../src/liquid-glass/fusion'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/gpu'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from '../../src/liquid-glass/volume-shader'
import { planVolumeBands, planVolumeGroups, VolumeGroups, writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups'
import { glassVolumeRenderOrder } from '../../src/render-order'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 创建一块独立玻璃，水平位置决定是否与其他玻璃相连。 */
function surface(id: number, left: number, attributes: Record<string, string> = {}): VolumeSurface {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
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
    options: parseGlassOptions(element, 'light'),
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
  const volumePipelines = () => fake.pipelines.filter(pipeline => String(pipeline.label).startsWith('volume:'))
  return { ...fake, groups, volumePipelines }
}

describe('三维玻璃组', () => {
  it('成员变化时复用同等数量的管线', () => {
    const { gpu, groups, volumePipelines } = setup()
    gpu.beginFrame()
    const first = groups.plan([
      surface(1, 0),
      surface(2, 400),
    ], {} as GPUTextureView, SHADING)
    expect(first).toHaveLength(2)
    expect(volumePipelines()).toHaveLength(1)

    // 滚动后换成另外两块独立玻璃，不再创建管线。
    gpu.beginFrame()
    const second = groups.plan([
      surface(5, 0),
      surface(9, 400),
    ], {} as GPUTextureView, SHADING)
    expect(second.map(item => item.pipeline)).toEqual(first.map(item => item.pipeline))
    expect(volumePipelines()).toHaveLength(1)

    // 两块相连后只用一组，按两名成员取用一条新管线；之后再分开时直接复用。
    gpu.beginFrame()
    expect(groups.plan([
      surface(5, 0),
      surface(9, 110),
    ], {} as GPUTextureView, SHADING)).toHaveLength(1)
    gpu.beginFrame()
    groups.plan([
      surface(7, 0),
      surface(8, 400),
    ], {} as GPUTextureView, SHADING)
    gpu.beginFrame()
    groups.plan([
      surface(3, 0),
      surface(4, 110),
    ], {} as GPUTextureView, SHADING)
    expect(volumePipelines().map(pipeline => pipeline.label)).toEqual([
      'volume:1:bgra8unorm-srgb',
      'volume:2:bgra8unorm-srgb',
    ])
  })

  it('低分辨率着色画进离屏目标，再用互不重叠的分块合成', () => {
    const { gpu, groups, pipelines } = setup()
    gpu.beginFrame()
    const items = groups.plan([
      surface(1, 0),
      surface(2, 60),
    ], {} as GPUTextureView, { ...SHADING, scale: 0.5 })
    expect(pipelines.map(pipeline => pipeline.label)).toContain('volume:2:rgba16float')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => String((item.pipeline as unknown as { label: string }).label).startsWith('blit:screen'))).toBe(true)
  })

  it('同层邻近的玻璃合成一组，其余各自成组', () => {
    const plans = planVolumeGroups([
      surface(1, 0),
      surface(2, 110),
      surface(3, 400),
      surface(4, 120, { 'data-glass-layer': '1' }),
    ], 1000, 600)
    expect(plans.map(plan => plan.members.map(member => member.id))).toEqual([
      [1, 2],
      [3],
      [4],
    ])
    expect(plans[2]!.order).toBeGreaterThan(plans[0]!.order)
    // 包围矩形包含融合与阴影的余量，并裁剪到视口之内。
    expect(plans[0]!.bounds.left).toBe(0)
    expect(plans[0]!.bounds.right).toBeGreaterThan(210)
  })

  it('按前景层的顺序把体积组分成两段', () => {
    const plans = planVolumeGroups([
      surface(1, 0),
      surface(2, 400, { 'data-glass-layer': '5' }),
    ], 1000, 600)
    const [below, above] = planVolumeBands(plans, glassVolumeRenderOrder(5, 0) - 0.5)
    expect(below!.groups.map(plan => plan.members[0]!.id)).toEqual([1])
    expect(above!.groups.map(plan => plan.members[0]!.id)).toEqual([2])
    expect(below!.cover).toHaveLength(1)
  })

  it('uniform 按着色器的成员布局写入', () => {
    const plans = planVolumeGroups([
      surface(1, 0, { 'data-glass-tint': '#ffffff', 'data-glass-tint-alpha': '0.5', 'data-glass-lens': '0.3' }),
    ], 1000, 600)
    const data = new Float32Array(HEADER_FLOATS + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS)
    writeVolumeGroup(data, 0, plans[0]!)
    const member = VOLUME_GROUP_FLOATS
    expect([
      ...data.slice(member, member + 4),
    ]).toEqual([50, 50, 50, 50])
    expect(data[member + 11]).toBeCloseTo(0.3)
    // 白色染色乘染色比例，在线性空间中为 0.5。
    expect(data[member + 20]).toBeCloseTo(0.5)
    expect(data[member + 23]).toBe(1)
  })
})
