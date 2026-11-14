import type { BackdropBlur } from '../../src/liquid-glass/blur.hot'
import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { blurReach } from '../../src/liquid-glass/blur.hot'
import { createContentPipelines } from '../../src/liquid-glass/content-shader'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { MAX_STACK_LEVELS, STACK_UV_EDGE } from '../../src/liquid-glass/stack.hot'
import { StackBackdrops } from '../../src/liquid-glass/StackBackdrops.hot'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups, VolumePlanner, writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

function surface(id: number, left: number, top: number, attributes: Record<string, string> = {}, size = 100): VolumeSurface {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value)
  const options = parseGlassOptions(element, 'light')
  return {
    id,
    left,
    top,
    width: size,
    height: size,
    layer: options.layer,
    host: null,
    clip: [-1e5, -1e5, 1e5, 1e5],
    opacity: 1,
    brightness: 1,
    paintOrder: 0,
    press: 0,
    materialize: 1,
    options,
    fusion: options.fusion,
  }
}

function levelsOf(planner: VolumePlanner): Record<number, number> {
  const result: Record<number, number> = {}
  for (const plan of planner.plans.slice(0, planner.count)) {
    for (const member of plan.members.slice(0, plan.count))
      result[member.id] = plan.level
  }
  return result
}

describe('多层玻璃的背景分级', () => {
  it('互不交叠的各层玻璃都留在第 0 级，取样整个视口', () => {
    const planner = new VolumePlanner()
    const surfaces = [
      surface(1, 0, 0),
      surface(2, 700, 400, { 'data-glass-layer': '1' }),
    ]
    planner.build(surfaces, surfaces.length, 1000, 600)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 0 })
    expect(planner.levels.map(level => level.used)).toEqual([true, false, false])
    const valid = planner.plans[0]!.valid
    expect([
      valid.left,
      valid.top,
      valid.right,
      valid.bottom,
    ]).toEqual([
      STACK_UV_EDGE,
      STACK_UV_EDGE,
      1 - STACK_UV_EDGE,
      1 - STACK_UV_EDGE,
    ])
  })

  it('上层玻璃盖在下层玻璃上时分到更高一级，下层记下看到它的组', () => {
    const planner = new VolumePlanner()
    const surfaces = [
      surface(1, 100, 100),
      surface(2, 150, 150, { 'data-glass-layer': '1' }),
      surface(3, 180, 180, { 'data-glass-layer': '2' }),
    ]
    planner.build(surfaces, surfaces.length, 1000, 600)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 1, 3: 2 })
    const plans = planner.plans.slice(0, planner.count)
    const bottom = plans.find(plan => plan.members[0]!.id === 1)!
    const middle = plans.find(plan => plan.members[0]!.id === 2)!
    const top = plans.find(plan => plan.members[0]!.id === 3)!
    expect(bottom.viewerOrders[1]).toBe(middle.order)
    expect(bottom.viewerOrders[2]).toBe(top.order)
    expect(middle.viewerOrders[2]).toBe(top.order)
    expect(top.viewerOrders.every(order => order === Infinity)).toBe(true)
    // 取样范围是上层本体向外扩展余量，并裁剪到视口。
    const region = planner.levels[1]!.region
    expect(region.left).toBe(Math.max(0, 150 - middle.margin))
    expect(region.right).toBe(Math.min(1000, 250 + middle.margin))
    expect(middle.valid.right).toBeCloseTo(region.right / 1000)
  })

  it('超过级数上限的组与最高一级共用背景', () => {
    const planner = new VolumePlanner()
    const surfaces = Array.from({ length: MAX_STACK_LEVELS + 2 }, (_, layer) =>
      surface(layer + 1, 100 + layer * 10, 100, {
        'data-glass-layer': String(layer),
      }))
    planner.build(surfaces, surfaces.length, 1000, 600)
    const levels = Object.values(levelsOf(planner))
    expect(Math.max(...levels)).toBe(MAX_STACK_LEVELS - 1)
    // 截断到同一级的组之间不算被看到。
    const capped = planner.plans.slice(0, planner.count).filter(plan => plan.level === MAX_STACK_LEVELS - 1)
    expect(capped.length).toBeGreaterThan(1)
    for (const plan of capped)
      expect(plan.viewerOrders[MAX_STACK_LEVELS - 1]).toBe(Infinity)
  })

  it('同层玻璃只在本体重叠时分级：相邻的控件不分级，嵌套玻璃看得到外层', () => {
    const planner = new VolumePlanner()
    const near = [
      surface(1, 0, 0, { 'data-glass-fusion': '0' }),
      {
        ...surface(2, 120, 0, { 'data-glass-fusion': '0' }),
        paintOrder: 0.5,
      },
    ]
    planner.build(near, near.length, 1000, 600)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 0 })

    const overlapping = [
      surface(1, 0, 0, { 'data-glass-fusion': '0' }),
      {
        ...surface(2, 50, 0, { 'data-glass-fusion': '0' }),
        paintOrder: 0.5,
      },
    ]
    planner.build(overlapping, overlapping.length, 1000, 600)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 1 })
    // 同层重叠时下层的文字也进入上层的背景。
    expect(planner.plans.slice(0, planner.count).find(plan => plan.level === 0)!.contentSeen[1]).toBe(true)

    const bar = {
      ...surface(1, 0, 0),
      width: 300,
      paintOrder: 0.1,
    }
    const tab = {
      ...surface(2, 10, 10),
      width: 80,
      height: 80,
      host: 1,
      paintOrder: 0.2,
    }
    planner.build([bar, tab], 2, 1000, 600)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 1 })
    // 外层的文字画在嵌套玻璃之上，嵌套玻璃的背景里只有外层的体积。
    const host = planner.plans.slice(0, planner.count).find(plan => plan.level === 0)!
    expect(host.viewerOrders[1]).toBeLessThan(Infinity)
    expect(host.contentSeen[1]).toBe(false)
  })

  it('同级共用的背景里，下层玻璃只画进看到它的组的取样范围', () => {
    // 标签栏的激活项嵌套在标签栏里（只看到体积）；远处第 1 层的面板看到标签栏的文字。两者都在第 1 级。
    const planner = new VolumePlanner()
    const bar = {
      ...surface(1, 0, 300),
      width: 400,
      height: 48,
      paintOrder: 0.1,
    }
    const tab = {
      ...surface(2, 4, 304),
      width: 80,
      height: 40,
      host: 1,
      paintOrder: 0.2,
    }
    const panel = {
      ...surface(3, 460, 0, { 'data-glass-layer': '1' }),
      width: 300,
      height: 500,
    }
    planner.build([bar, tab, panel], 3, 1200, 800)
    expect(levelsOf(planner)).toEqual({ 1: 0, 2: 1, 3: 1 })
    const plans = planner.plans.slice(0, planner.count)
    const host = plans.find(plan => plan.members[0]!.id === 1)!
    const tabPlan = plans.find(plan => plan.members[0]!.id === 2)!
    expect(host.contentSeen[1]).toBe(true)
    // 文字只画在面板的取样范围里，碰不到激活项。
    expect(host.contentRegions[1]!.left).toBeGreaterThan(tabPlan.body.right)
    // 体积两者都看到。
    expect(host.seenRegions[1]!.left).toBeLessThanOrEqual(tabPlan.body.left)
  })

  it('有效取样范围写在体积组 uniform 的成员之前', () => {
    const planner = new VolumePlanner()
    const surfaces = [
      surface(1, 100, 100),
      surface(2, 150, 150, { 'data-glass-layer': '1' }),
    ]
    planner.build(surfaces, surfaces.length, 1000, 600)
    const top = planner.plans.slice(0, planner.count).find(plan => plan.level === 1)!
    const data = new Float32Array(HEADER_FLOATS + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS)
    writeVolumeGroup(data, 0, top)
    expect(data[8]).toBeCloseTo(top.valid.left)
    expect(data[9]).toBeCloseTo(top.valid.top)
    expect(data[10]).toBeCloseTo(top.valid.right)
    expect(data[11]).toBeCloseTo(top.valid.bottom)
  })
})

describe('上层背景的绘制', () => {
  function setup() {
    const fake = createFakeGpu()
    const blurs = Array.from({ length: MAX_STACK_LEVELS }, () => ({
      views: [{}, {}, {}, {}, {}],
      generation: 0,
      plan: () => {},
      encode: () => {},
    }) as unknown as BackdropBlur)
    const volumes = new VolumeGroups(fake.gpu, blurs)
    const content = createContentPipelines(fake.gpu)
    const stack = new StackBackdrops(fake.gpu, blurs, content.stacked)
    const base = { view: {} as GPUTextureView, group: {} as GPUBindGroup }
    return { fake, volumes, stack, base, blurs }
  }

  it('没有交叠时不安排上层背景', () => {
    const { fake, volumes, stack, base } = setup()
    fake.gpu.frame.begin()
    const surfaces = [
      surface(1, 0, 0),
      surface(2, 700, 400, { 'data-glass-layer': '1' }),
    ]
    volumes.group(surfaces, surfaces.length, 1000, 600)
    volumes.setSource(0, base.view)
    stack.plan(volumes, base, [], [], new Float64Array(0), 0, 1000, 600)
    expect(volumes.groups.levels.slice(1).every(level => !level.used)).toBe(true)
    expect(fake.pipelines.map(pipeline => String(pipeline.label))).not.toContain('blit:screenOpaque:1')
  })

  it('上层背景先复制页面背景，再按顺序画下层体积', () => {
    const { fake, volumes, stack, base } = setup()
    fake.gpu.frame.begin()
    const surfaces = [
      surface(1, 100, 100),
      surface(2, 150, 150, { 'data-glass-layer': '1' }),
    ]
    volumes.group(surfaces, surfaces.length, 1000, 600)
    volumes.setSource(0, base.view)
    stack.plan(volumes, base, [], [], new Float64Array(0), 0, 1000, 600)
    const labels = fake.pipelines.map(pipeline => String(pipeline.label))
    expect(labels).toContain('blit:screenOpaque:1')
    expect(labels).toContain('volume:1:1')
    // 背景纹理按 CSS 分辨率创建。
    const textures = (fake.device.createTexture as unknown as { mock: { calls: [{ size: { width: number, height: number } }][] } }).mock.calls
    expect(textures.some(([descriptor]) => descriptor.size.width === 1000 && descriptor.size.height === 600)).toBe(true)
    const list = new DrawList()
    volumes.draw({
      scale: 1,
      pixelWidth: 2000,
      pixelHeight: 1200,
      cssWidth: 1000,
      cssHeight: 600,
      split: Infinity,
    }, list)
    expect(list.count).toBe(2)
  })
})

describe('局部模糊的余量', () => {
  it('按实际生成的各级累加核半径', () => {
    expect(blurReach(0)).toBe(0)
    // 只需要第一级（σ = 2）时，余量是三倍标准差。
    expect(blurReach(4)).toBeCloseTo(6)
    expect(blurReach(80 * 80)).toBeGreaterThan(blurReach(16 * 16))
  })
})
