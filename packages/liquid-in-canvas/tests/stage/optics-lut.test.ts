import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { LUT_ROWS_PER_PROFILE, LUT_SAMPLES, ProfileTable, toHalf, traceProfile } from '../../src/liquid-glass/optics-lut'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { createProfileVolumeShader } from '../../src/liquid-glass/volume-profile-shader'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups, VolumePlanner, writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

const DEFAULT_KEY = {
  bevelWidth: 0.68,
  bevelHeight: 0.68,
  curve: 3,
  bottomBevel: 1,
  dispersion: 0,
}

describe('截面光路查找表', () => {
  it('倒角以内的平顶不偏移，轮廓附近朝内取样', () => {
    const samples = traceProfile(DEFAULT_KEY)
    expect(samples).toHaveLength(LUT_SAMPLES)
    const flat = samples.at(-1)!
    expect(flat.hit).toBe(1)
    expect(Math.abs(flat.shift[1])).toBeLessThan(1e-3)
    expect(Math.abs(flat.slope[1])).toBeLessThan(1e-3)
    expect(flat.normal[1]).toBeCloseTo(1, 3)
    // 倒角中段：法线朝外倾斜，取样位置向内（外法向的负方向）。
    const middle = samples[Math.round(LUT_SAMPLES * 0.6)]!
    expect(middle.hit).toBe(1)
    expect(middle.normal[0]).toBeGreaterThan(0.05)
    expect(middle.shift[1]).toBeLessThan(0)
    expect(middle.slope[1]).toBeLessThan(0)
  })

  it('色散时蓝光比红光偏折更多', () => {
    const samples = traceProfile({ ...DEFAULT_KEY, dispersion: 1 })
    const middle = samples[Math.round(LUT_SAMPLES * 0.6)]!
    expect(middle.slope[2]).toBeLessThan(middle.slope[0])
  })

  it('同样的截面参数共用一行，新参数追加一行', () => {
    const table = new ProfileTable(null)
    const first = table.rowOf(0.68, 0.68, 3, 1, 0.3)
    expect(table.rowOf(0.68, 0.68, 3, 1, 0.3)).toBe(first)
    expect(table.rowOf(0.6801, 0.68, 3, 1, 0.3)).toBe(first)
    expect(table.rowOf(1, 0.68, 3, 1, 0.3)).toBe(first + 1)
    expect(table.size).toBe(2)
  })

  it('纹理按行数扩容并上传每一行', () => {
    const fake = createFakeGpu()
    const table = new ProfileTable(fake.gpu)
    table.rowOf(0.68, 0.68, 3, 1, 0)
    const texture = (fake.device.createTexture as unknown as { mock: { calls: [{ size: { width: number, height: number }, format: string }][] } }).mock.calls.at(-1)![0]
    expect(texture.format).toBe('rgba16float')
    expect(texture.size.width).toBe(LUT_SAMPLES)
    expect(texture.size.height % LUT_ROWS_PER_PROFILE).toBe(0)
    expect(fake.queue.writeTexture).toHaveBeenCalledTimes(1)
  })

  it('半精度编码', () => {
    expect(toHalf(0)).toBe(0)
    expect(toHalf(1)).toBe(0x3C00)
    expect(toHalf(-2)).toBe(0xC000)
    expect(toHalf(0.5)).toBe(0x3800)
  })
})

describe('剖面光学', () => {
  it('着色器取样背景、各级模糊与查找表，并按成员数量展开', () => {
    const code = createProfileVolumeShader(3)
    expect(code).toContain(`@group(1) @binding(${VOLUME_TEXTURES}) var lut`)
    expect(code).toContain('u.members[2]')
    expect(code).not.toContain('u.members[3]')
    expect(code).not.toContain('glass_entry')
  })

  it('剖面光学下 uniform 写入查找表行号，并改用剖面管线', () => {
    const element = document.createElement('div')
    const options = parseGlassOptions(element, 'light')
    const surface = {
      id: 1,
      left: 0,
      top: 0,
      width: 120,
      height: 48,
      layer: 0,
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
    const planner = new VolumePlanner()
    planner.build([surface], 1, 1000, 600)
    const table = new ProfileTable(null)
    const data = new Float32Array(HEADER_FLOATS + VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS)
    writeVolumeGroup(data, 0, planner.plans[0]!, table)
    expect(data[VOLUME_GROUP_FLOATS + 28]).toBe(0)
    expect(table.size).toBe(1)

    const fake = createFakeGpu()
    const blur = {
      views: [{}, {}, {}, {}, {}],
      generation: 0,
    } as never
    const groups = new VolumeGroups(fake.gpu, [blur])
    groups.setOptics('profile')
    fake.gpu.frame.begin()
    const list = new DrawList()
    groups.plan([surface], 1, {} as GPUTextureView, {
      scale: 1,
      pixelWidth: 2000,
      pixelHeight: 1200,
      cssWidth: 1000,
      cssHeight: 600,
      split: Infinity,
    }, list)
    expect(fake.pipelines.map(pipeline => String(pipeline.label))).toContain('volume-profile:0:1')
  })
})
