import type { BackdropBlur } from '../../src/liquid-glass/blur.hot'
import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { encodeProfile, LUT_ROWS_PER_PROFILE, LUT_SAMPLES, ProfileTable, toHalf, traceProfile } from '../../src/liquid-glass/optics-lut'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { createHybridVolumeShader, HYBRID_REACH_PAD, HYBRID_REACH_SCALE } from '../../src/liquid-glass/volume-hybrid-shader'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups, VolumePlanner, writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 没有裁剪祖先时的裁剪范围。 */
const UNCLIPPED = [-1e5, -1e5, 1e5, 1e5]

/** 创建一块 200 × 100 的玻璃，水平位置决定是否与其他玻璃相连。 */
function surface(id: number, left: number, clip: number[] = UNCLIPPED): VolumeSurface {
  const options = parseGlassOptions(document.createElement('div'), 'light')
  return {
    id,
    left,
    top: 200,
    width: 200,
    height: 100,
    layer: options.layer,
    host: null,
    clip,
    opacity: 1,
    brightness: 1,
    paintOrder: id / 100,
    press: 0,
    materialize: 1,
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
  const groups = new VolumeGroups(fake.gpu, [blur])
  // 这里检查逐帧求交的混合光路；折射场缓存见 field-cache.test.ts。
  groups.setFieldCache(false)
  const list = new DrawList()
  /** 画一帧，返回每个绘制项的管线标签与 uniform 起始下标（浮点数）。 */
  const frame = (surfaces: VolumeSurface[], shading = SHADING) => {
    fake.gpu.frame.begin()
    list.reset()
    groups.plan(surfaces, surfaces.length, {} as GPUTextureView, shading, list)
    return list.items.slice(0, list.count).map(item => ({
      label: String((item.pipeline as unknown as { label: string }).label),
      start: item.uniform / 4,
      textures: item.textures,
    }))
  }
  const bindGroups = fake.device.createBindGroup as unknown as { mock: { calls: [{ entries: unknown[] }][] } }
  return {
    ...fake,
    groups,
    frame,
    data: () => fake.gpu.frame.data,
    bindGroups,
  }
}

describe('混合光路', () => {
  it('着色器同时包含查表与逐步求交，按成员数量展开', () => {
    const code = createHybridVolumeShader(3)
    expect(code).toContain(`@group(1) @binding(${VOLUME_TEXTURES}) var lut`)
    expect(code).toContain('glass_lookup(field, xy, screen_uv)')
    expect(code).toContain('glass_trace(xy, screen_uv)')
    expect(code).toContain('members: array<Member, 3>')
    expect(code).toContain('u.members[2]')
    expect(code).not.toContain('u.members[3]')
    // 归属成员按下标取用，每名成员在归属判断里各出现一次。
    expect(code).toContain('u.members[owner]')
    expect(code.match(/owner = \d+;/g)).toEqual(['owner = 0;', 'owner = 1;', 'owner = 2;'])
    const member = /struct Member \{([^}]*)\}/.exec(code)?.[1] ?? ''
    expect((member.match(/: vec4f/g) ?? []).length * 4).toBe(VOLUME_MEMBER_FLOATS)
  })

  it('只有一名成员的组用剖面管线，融合的组用混合管线', () => {
    const { groups, frame } = setup()
    groups.setOptics('hybrid')
    const items = frame([
      surface(1, 0),
      surface(2, 210),
      surface(3, 700),
    ])
    expect(items.map(item => item.label).sort()).toEqual(['volume-hybrid:0:2', 'volume-profile:0:1'])
  })

  it('裁剪切进玻璃时，只有一名成员的组也用混合管线', () => {
    const { groups, frame } = setup()
    groups.setOptics('hybrid')
    // 裁剪范围远在玻璃之外：不影响光路。
    expect(frame([
      surface(1, 300, [0, 0, 1000, 600]),
    ]).map(item => item.label)).toEqual(['volume-profile:0:1'])
    // 裁剪边穿过玻璃。
    expect(frame([
      surface(1, 300, [350, 0, 1000, 600]),
    ]).map(item => item.label)).toEqual(['volume-hybrid:0:1'])
    // 裁剪边在玻璃之外，但比光线的横向位移加半厚度更近。
    expect(frame([
      surface(1, 300, [280, 0, 1000, 600]),
    ]).map(item => item.label)).toEqual(['volume-hybrid:0:1'])
  })

  it('降低着色分辨率时用离屏目标格式的同一种管线', () => {
    const { groups, frame, pipelines } = setup()
    groups.setOptics('hybrid')
    frame([
      surface(1, 0),
      surface(2, 210),
      surface(3, 700),
    ], { ...SHADING, scale: 0.5 })
    const labels = pipelines.map(pipeline => String(pipeline.label))
    expect(labels).toContain('volume-hybrid:1:2')
    expect(labels).toContain('volume-profile:1:1')
    expect(labels.some(label => label.startsWith('volume:'))).toBe(false)
  })

  it('两种管线都写入查找表行号与混合光路的最小间距，并绑定查找表', () => {
    const { groups, frame, data, bindGroups } = setup()
    groups.setOptics('hybrid')
    const items = frame([
      surface(1, 0),
      surface(2, 210),
      surface(3, 700),
    ])
    const fused = items.find(item => item.label === 'volume-hybrid:0:2')!
    const single = items.find(item => item.label === 'volume-profile:0:1')!
    const group = fused.start + HEADER_FLOATS
    const fusion = surface(1, 0).options.fusion
    // 两名成员：其余成员不参与合并的最小距离是 2 × 融合距离 + 1，小于平顶捷径在三维求交里用的范围。
    expect(data()[group + 3]).toBe(fusion * 2 + 1)
    expect(data()[group + 1]).toBe(fusion * 2 * 1.5 + 1)
    // 三块玻璃的截面相同，共用查找表的第 0 行。
    for (const member of [group + VOLUME_GROUP_FLOATS, group + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS, single.start + HEADER_FLOATS + VOLUME_GROUP_FLOATS])
      expect(data()[member + 28]).toBe(0)
    // 两种管线共用同一份纹理绑定：背景、各级模糊与查找表。
    expect(fused.textures).toBe(single.textures)
    expect(bindGroups.mock.calls.at(-1)![0].entries).toHaveLength(VOLUME_TEXTURES + 1)
  })

  it('三维求交不写行号、不绑定查找表；切换光路后同一帧结构改用对应管线', () => {
    const { groups, frame, bindGroups } = setup()
    const surfaces = [
      surface(1, 0),
      surface(2, 210),
      surface(3, 700),
    ]
    groups.setOptics('raymarch')
    expect(frame(surfaces).map(item => item.label).sort()).toEqual(['volume:0:1', 'volume:0:2'])
    expect(bindGroups.mock.calls.at(-1)![0].entries).toHaveLength(VOLUME_TEXTURES)
    groups.setOptics('profile')
    expect(frame(surfaces).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    groups.setOptics('hybrid')
    expect(frame(surfaces).map(item => item.label).sort()).toEqual(['volume-hybrid:0:2', 'volume-profile:0:1'])
  })

  it('混合光路预热只有一名成员时的两条管线，以及更多成员的混合管线', () => {
    const { gpu, groups } = setup()
    const warmed: string[] = []
    gpu.compileAsync = (label: string) => {
      warmed.push(label)
      return null
    }
    groups.setOptics('hybrid')
    groups.warm([1, 2])
    expect(warmed.sort()).toEqual([
      'volume-hybrid:0:1',
      'volume-hybrid:0:2',
      'volume-hybrid:1:1',
      'volume-hybrid:1:2',
      'volume-profile:0:1',
      'volume-profile:1:1',
    ])
  })

  it('writeVolumeGroup 报告裁剪是否切进玻璃；没有查找表时不判断', () => {
    const planner = new VolumePlanner()
    const table = new ProfileTable(null)
    const data = new Float32Array(HEADER_FLOATS + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS)
    const cutBy = (clip: number[], profiles: ProfileTable | null = table) => {
      planner.build([
        surface(1, 300, clip),
      ], 1, 1000, 600)
      return writeVolumeGroup(data, 0, planner.plans[0]!, profiles)
    }
    expect(cutBy(UNCLIPPED)).toBe(false)
    expect(cutBy([350, 0, 1000, 600])).toBe(true)
    expect(cutBy([350, 0, 1000, 600], null)).toBe(false)
    // 玻璃 200 × 100，半厚度 30：裁剪边要比“这一行的最大横向位移 + 半厚度”再远几个像素才不算切进。
    const pad = table.reachOf(0) * 30 * HYBRID_REACH_SCALE + HYBRID_REACH_PAD + 30
    expect(cutBy([300 - pad, 0, 1000, 600])).toBe(true)
    expect(cutBy([300 - pad - 10, 0, 1000, 600])).toBe(false)
    expect(cutBy([0, 0, 500 + pad - 1, 600])).toBe(true)
    expect(cutBy([0, 200 - pad + 1, 1000, 600])).toBe(true)
    expect(cutBy([0, 0, 1000, 300 + pad - 1])).toBe(true)
  })

  it('成员越多，混合光路要求其余成员保持的距离越大，但始终不超过平顶捷径的范围', () => {
    const planner = new VolumePlanner()
    const fusion = surface(1, 0).options.fusion
    for (const count of [1, 2, 3, 5]) {
      const surfaces = Array.from({ length: count }, (_, i) => surface(i + 1, i * 210))
      planner.build(surfaces, count, 2000, 600)
      expect(planner.count).toBe(1)
      const plan = planner.plans[0]!
      expect(plan.apart).toBe(fusion * 2 * (1 + Math.max(0, count - 2) / 4) + 1)
      expect(plan.apart).toBeLessThanOrEqual(plan.reach)
    }
  })
})

describe('查找表里的横向范围', () => {
  const KEY = {
    bevelWidth: 0.8,
    bevelHeight: 1,
    curve: 2.75,
    bottomBevel: 1,
    dispersion: 0.05,
  }

  it('平顶上光线不离开入射位置，倒角上有横向位移', () => {
    const samples = traceProfile(KEY)
    expect(samples.at(-1)!.reach).toBeLessThan(1e-3)
    const middle = samples[Math.round(LUT_SAMPLES * 0.5)]!
    expect(middle.reach).toBeGreaterThan(0.1)
    // 底面倒角与顶面相同、底面贴着背景平面时，有效光路的 shift 就是玻璃内的横向位移，不会超过途中的最大值。
    for (const sample of samples.filter(sample => sample.hit && Math.min(...sample.valid) > 0.99))
      expect(sample.reach + 0.05).toBeGreaterThan(Math.abs(sample.shift[1]))
  })

  it('编码成每行的第四条纹素行，取相邻三个样本的最大值', () => {
    const samples = traceProfile(KEY)
    const data = encodeProfile(samples)
    expect(data).toHaveLength(LUT_SAMPLES * 4 * LUT_ROWS_PER_PROFILE)
    const row = 3 * LUT_SAMPLES * 4
    for (const i of [0, 1, 40, 90, LUT_SAMPLES - 1]) {
      const expected = Math.max(samples[i - 1]?.reach ?? 0, samples[i]!.reach, samples[i + 1]?.reach ?? 0)
      expect(data[row + i * 4]).toBe(toHalf(expected))
    }
  })

  it('reachOf 返回整行的最大值', () => {
    const table = new ProfileTable(null)
    const row = table.rowOf(KEY.bevelWidth, KEY.bevelHeight, KEY.curve, KEY.bottomBevel, KEY.dispersion)
    const samples = traceProfile(KEY)
    expect(table.reachOf(row)).toBe(Math.max(...samples.map(sample => sample.reach)))
    expect(table.reachOf(row)).toBeGreaterThan(1)
  })
})
