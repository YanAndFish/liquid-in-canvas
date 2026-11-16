import type { BackdropBlur } from '../../src/liquid-glass/blur.hot'
import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { TEXTURE_USAGE } from '../../src/gpu'
import { FIELD_FADE_IN_MS, FIELD_FADE_OUT_MS, FIELD_FLAP_MS, FIELD_IDLE_FRAMES, FIELD_SETTLE_MAX_MS, FIELD_SETTLE_MS, FIELD_TEXEL_BUDGET } from '../../src/liquid-glass/field-cache'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { createFieldBakeShader, FIELD_FORMATS, FIELD_TARGETS, FIELD_TEXEL_BYTES } from '../../src/liquid-glass/volume-field-shader'
import { createHybridVolumeShader } from '../../src/liquid-glass/volume-hybrid-shader'
import { createVolumeShader, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups, volumeHalfDepth } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

const UNCLIPPED = [-1e5, -1e5, 1e5, 1e5]

function surface(id: number, left: number, top = 200, clip: number[] = UNCLIPPED): VolumeSurface {
  const options = parseGlassOptions(document.createElement('div'), 'light')
  return {
    id,
    left,
    top,
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

const TICK = 16

interface Item {
  label: string
  start: number
  textures: GPUBindGroup
}

function fakeEncoder() {
  const passes: { views: unknown[], clear: unknown[], load: unknown[], labels: string[], uniforms: number[] }[] = []
  const encoder = {
    beginRenderPass(descriptor: GPURenderPassDescriptor) {
      const attachments = [...descriptor.colorAttachments] as GPURenderPassColorAttachment[]
      const pass = {
        views: attachments.map(attachment => attachment.view),
        clear: attachments.map(attachment => attachment.clearValue),
        load: attachments.map(attachment => attachment.loadOp),
        labels: [] as string[],
        uniforms: [] as number[],
      }
      passes.push(pass)
      return {
        setPipeline: (pipeline: { label: string }) => pass.labels.push(pipeline.label),
        setBindGroup: (index: number, _group: unknown, offsets?: Uint32Array) => {
          if (index === 0 && offsets)
            pass.uniforms.push(offsets[0]! / 4)
        },
        draw: () => {},
        end: () => {},
      }
    },
  }
  return { passes, encoder: encoder as unknown as GPUCommandEncoder }
}

function setup() {
  const fake = createFakeGpu()
  const blur = {
    views: [{}, {}, {}, {}, {}],
    generation: 0,
  } as unknown as BackdropBlur
  const groups = new VolumeGroups(fake.gpu, [blur])
  groups.setOptics('hybrid')
  const list = new DrawList()
  let now = 1000
  const frameAt = (time: number, surfaces: VolumeSurface[], shading = SHADING): Item[] => {
    now = time
    fake.gpu.frame.begin()
    list.reset()
    groups.plan(surfaces, surfaces.length, {} as GPUTextureView, shading, list, now)
    return list.items.slice(0, list.count).map(item => ({
      label: String((item.pipeline as unknown as { label: string }).label),
      start: item.uniform / 4,
      textures: item.textures,
    }))
  }
  const frame = (surfaces: VolumeSurface[], shading = SHADING): Item[] => frameAt(now + TICK, surfaces, shading)
  const run = (frames: number, surfaces: VolumeSurface[], shading = SHADING): Item[] => {
    let items: Item[] = []
    for (let i = 0; i < frames; i++)
      items = frame(surfaces, shading)
    return items
  }
  const encode = () => {
    const { passes, encoder } = fakeEncoder()
    fake.gpu.frame.beginEncoding()
    groups.encode(encoder)
    return passes
  }
  const createTexture = fake.device.createTexture as unknown as {
    mock: {
      calls: [{ size: { width: number, height: number }, format: string, usage: number }][]
      results: { value: { width: number, height: number, destroy: { mock: { calls: unknown[] } } } }[]
    }
  }
  const FIELD_USAGE = TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_DST
  const fieldTextures = (empty = false) => createTexture.mock.results
    .map(result => result.value)
    .filter((texture, index) => {
      const [descriptor] = createTexture.mock.calls[index]!
      return FIELD_FORMATS.includes(descriptor.format as GPUTextureFormat) && descriptor.usage === FIELD_USAGE && (texture.width === 1) === empty
    })
  const bindGroups = fake.device.createBindGroup as unknown as { mock: { calls: [{ entries: { resource: unknown }[] }][] } }
  const fieldOf = (item: Item) => {
    const at = item.start + HEADER_FLOATS + 12
    return [
      ...fake.gpu.frame.data.subarray(at, at + 4),
    ]
  }
  const dirtyOf = (item: Item) => {
    const at = item.start + HEADER_FLOATS
    return [
      ...fake.gpu.frame.data.subarray(at + 16, at + 20),
      fake.gpu.frame.data[at + 6]!,
    ]
  }
  return {
    ...fake,
    groups,
    dirtyOf,
    frame,
    frameAt,
    run,
    encode,
    fieldTextures,
    bindGroups,
    fieldOf,
    now: () => now,
    data: () => fake.gpu.frame.data,
  }
}

function scene(dx = 0, dy = 0): VolumeSurface[] {
  return [
    surface(1, dx, 200 + dy),
    surface(2, 210 + dx, 200 + dy),
    surface(3, 700 + dx, 200 + dy),
  ]
}

const SETTLE_FRAMES = Math.ceil((FIELD_SETTLE_MS + FIELD_FADE_IN_MS) / TICK) + 3

describe('折射场缓存的着色器', () => {
  it('三张纹理合计不超过 WebGPU 缺省的每个样本 32 字节的颜色附件上限', () => {
    const bytes: Record<string, number> = { rgba32float: 16, rgba16float: 8 }
    expect(FIELD_FORMATS.reduce((sum, format) => sum + bytes[format]!, 0)).toBe(FIELD_TEXEL_BYTES)
    expect(FIELD_TEXEL_BYTES).toBeLessThanOrEqual(32)
  })

  it('单精度的折射场按不可过滤的纹理绑定，管线布局与绑定布局一致', () => {
    const { device, run } = setup()
    run(SETTLE_FRAMES, scene())
    const layouts = (device.createBindGroupLayout as unknown as { mock: { calls: [{ entries: { texture?: { sampleType: string } }[] }][] } }).mock.calls
    const field = layouts
      .filter(([descriptor]) => descriptor.entries.every(entry => entry.texture))
      .map(([descriptor]) => descriptor.entries.map(entry => entry.texture!.sampleType))
      .filter(types => types.length === VOLUME_TEXTURES + 1 + FIELD_TARGETS)
    expect(field).toHaveLength(1)
    expect(field[0]!.slice(VOLUME_TEXTURES + 1)).toEqual(FIELD_FORMATS.map(format => format === 'rgba32float'
      ? 'unfilterable-float'
      : 'float'))
    expect(field[0]!.slice(0, VOLUME_TEXTURES + 1).every(type => type === 'float')).toBe(true)
  })

  it('写入缓存的着色器同时输出三张纹理，只追踪光路、不取样背景', () => {
    const code = createFieldBakeShader(2)
    expect(FIELD_TARGETS).toBe(3)
    expect(code.match(/@location\(\d\) \w+: vec4f/g)).toHaveLength(FIELD_TARGETS)
    const body = code.slice(code.indexOf('fn bake('))
    expect(body).toContain('glass_paths(entry.xyz')
    expect(body).not.toContain('sample_blur')
    expect(body).not.toContain('glass_shade')
    expect(body).toContain('if (!on_slab && !alone)')
    expect(createHybridVolumeShader(2)).toContain('if (on_slab)')
  })

  it('读缓存的混合着色器多绑定三张折射场，没有光路的纹素仍然逐步求交', () => {
    const cached = createHybridVolumeShader(3, true)
    for (let i = 0; i < FIELD_TARGETS; i++)
      expect(cached).toContain(`@group(1) @binding(${VOLUME_TEXTURES + 1 + i}) var field${i}`)
    const body = cached.slice(cached.indexOf('fn volume('))
    expect(body).toContain('textureLoad(field2, texel, 0)')
    expect(body).toContain('glass_shade(screen_uv, glass_material(vec3f(xy, stored.w)), paths)')
    expect(body).toContain('shaded = glass_trace(xy, screen_uv);')
    expect(body).toContain('glass_lookup(glass_field(xy), xy, screen_uv)')
    expect(cached).toContain('fn glass_field(')
    const plain = createHybridVolumeShader(3)
    expect(plain).not.toContain('field0')
    expect(plain).not.toContain('fn glass_field(')
  })

  it('三种体积着色器的 uniform 都带折射场字段，逐步求交拆成光路与着色两步', () => {
    for (const code of [
      createVolumeShader(2),
      createHybridVolumeShader(2),
      createFieldBakeShader(2),
    ]) {
      const uniforms = /struct Uniforms \{([^}]*)\}/.exec(code)?.[1] ?? ''
      expect((uniforms.match(/: vec4f/g) ?? []).length * 4).toBe(HEADER_FLOATS + VOLUME_GROUP_FLOATS)
      expect(code).toContain('fn glass_paths(')
      expect(code).toContain('fn glass_shade(')
    }
  })
})

describe('折射场缓存', () => {
  it('几何刚出现时融合的组先查表，静止满规定时间后求交一次并写入缓存', () => {
    const { frame, frameAt, now, groups, encode, fieldTextures, pipelines, fieldOf } = setup()
    const start = now()
    expect(frameAt(start, scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    expect(groups.settling).toBe(true)
    expect(encode()).toHaveLength(0)
    expect(frameAt(start + FIELD_SETTLE_MS - 1, scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    expect(fieldTextures()).toHaveLength(0)

    const items = frameAt(start + FIELD_SETTLE_MS, scene())
    expect(items.map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    const fused = items.find(item => item.label === 'volume-field:0:2')!
    const [originX, originY, scale, fade] = fieldOf(fused)
    expect(scale).toBe(1)
    expect(fade).toBe(0)
    expect(Number.isInteger(originX)).toBe(true)
    expect(Number.isInteger(originY)).toBe(true)
    const textures = fieldTextures()
    expect(textures).toHaveLength(FIELD_TARGETS)
    const passes = encode()
    expect(passes).toHaveLength(1)
    expect(passes[0]!.labels).toEqual(['volume-bake:2'])
    expect(passes[0]!.views).toHaveLength(FIELD_TARGETS)
    expect(passes[0]!.clear[FIELD_TARGETS - 1]).toMatchObject({ a: -1 })
    const bake = pipelines.find(pipeline => pipeline.label === 'volume-bake:2')!
    expect([...bake.fragment!.targets].map(target => target!.format)).toEqual(['rgba32float', 'rgba16float', 'rgba16float'])
    expect(groups.settling).toBe(true)

    frame(scene())
    expect(encode()).toHaveLength(0)
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS)
  })

  it('缓存只覆盖两块玻璃的连接处，纹素数按着色倍率分配', () => {
    const { run, fieldTextures } = setup()
    run(SETTLE_FRAMES, scene())
    const texture = fieldTextures()[0]!
    expect(texture.width).toBeGreaterThan(0)
    expect(texture.width).toBeLessThan(820)
    expect(texture.height).toBeLessThanOrEqual(288)
    expect(texture.width * texture.height).toBeLessThan(FIELD_TEXEL_BUDGET / 4)
  })

  it('写入缓存时按画面上对应像素的坐标求交：成员与目标尺寸不变，只加上缓存左上角的像素位置', () => {
    const { frameAt, now, encode, data, fieldOf, fieldTextures } = setup()
    const start = now()
    frameAt(start, scene())
    const items = frameAt(start + FIELD_SETTLE_MS, scene())
    const fused = items.find(item => item.label === 'volume-field:0:2')!
    const [originX, originY] = fieldOf(fused)
    const bake = encode()[0]!.uniforms[0]!
    const texture = fieldTextures()[0]!
    expect(texture.width).toBeGreaterThan(0)
    expect([
      ...data().subarray(bake, bake + 8),
    ]).toEqual([
      -1,
      1,
      1,
      -1,
      SHADING.pixelWidth,
      SHADING.pixelHeight,
      SHADING.cssWidth,
      SHADING.cssHeight,
    ])
    expect(data()[bake + HEADER_FLOATS + 12]).toBe(originX)
    expect(data()[bake + HEADER_FLOATS + 13]).toBe(originY)
    const live = fused.start + HEADER_FLOATS + VOLUME_GROUP_FLOATS
    const baked = bake + HEADER_FLOATS + VOLUME_GROUP_FLOATS
    expect([
      ...data().subarray(baked, baked + 2 * VOLUME_MEMBER_FLOATS),
    ]).toEqual([
      ...data().subarray(live, live + 2 * VOLUME_MEMBER_FLOATS),
    ])
  })

  it('求交结果按时间淡入，淡入完成后不再要求重绘', () => {
    const { frame, frameAt, now, groups, fieldOf } = setup()
    const start = now()
    frameAt(start, scene())
    frameAt(start + FIELD_SETTLE_MS, scene())
    const fades: number[] = []
    for (let i = 0; i < 12; i++) {
      const fused = frame(scene()).find(item => item.label === 'volume-field:0:2')!
      fades.push(fieldOf(fused)[3]!)
    }
    expect(fades[0]).toBeCloseTo(TICK / FIELD_FADE_IN_MS, 5)
    for (let i = 1; i < fades.length; i++)
      expect(fades[i]).toBeGreaterThanOrEqual(fades[i - 1]!)
    expect(fades.at(-1)).toBe(1)
    expect(groups.settling).toBe(false)
  })

  it('整组平移不让缓存失效，缓存的位置随之移动', () => {
    const { run, frame, encode, fieldOf, fieldTextures, groups } = setup()
    const before = run(SETTLE_FRAMES, scene()).find(item => item.label === 'volume-field:0:2')!
    const [originX, originY] = fieldOf(before)
    for (const [dx, dy] of [
      [0, -37],
      [12.5, -80],
      [-3, 41],
    ]) {
      const moved = frame(scene(dx, dy)).find(item => item.label === 'volume-field:0:2')!
      expect(moved).toBeDefined()
      expect(encode()).toHaveLength(0)
      const field = fieldOf(moved)
      expect(field[0]).toBe(originX! + Math.round(dx! * 2))
      expect(field[1]).toBe(originY! + Math.round(dy! * 2))
      expect(field[3]).toBe(1)
    }
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS)
    expect(groups.settling).toBe(false)
  })

  it('成员相对运动时缓存失效：上一次的结果淡出，随后用剖面管线，停下后重新求交', () => {
    const { run, frame, encode, fieldOf, fieldTextures, groups } = setup()
    run(SETTLE_FRAMES, scene())
    const moving = (step: number): VolumeSurface[] => [
      surface(1, 0),
      surface(2, 210 + step * 2),
      surface(3, 700),
    ]
    const fades: number[] = []
    let step = 1
    for (;; step++) {
      const fused = frame(moving(step)).find(item => item.label.endsWith(':2'))!
      expect(encode()).toHaveLength(0)
      if (fused.label !== 'volume-field:0:2')
        break
      fades.push(fieldOf(fused)[3]!)
    }
    expect(fades[0]).toBeCloseTo(1 - TICK / FIELD_FADE_OUT_MS, 5)
    expect(fades.length).toBe(Math.ceil(FIELD_FADE_OUT_MS / TICK) - 1)
    expect(groups.settling).toBe(true)
    for (let i = 0; i < 3; i++)
      expect(frame(moving(++step)).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])

    const rest = moving(step)
    let bakes = 0
    for (let i = 0; i < SETTLE_FRAMES; i++) {
      frame(rest)
      bakes += encode().length
    }
    expect(bakes).toBe(1)
    expect(frame(rest).map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    expect(fieldTextures().filter(texture => texture.destroy.mock.calls.length === 0)).toHaveLength(FIELD_TARGETS)
    expect(groups.settling).toBe(false)
  })

  it('成员小幅漂移（弹簧收敛的尾巴、很慢的拖动）时缓存不作废：同一帧按新的几何重新求交，不淡出', () => {
    const { run, frame, encode, fieldOf, groups } = setup()
    run(SETTLE_FRAMES, scene())
    let x = 210
    for (const step of [0.3, 0.3, 0.2, 0.1, 0.05]) {
      x += step
      const surfaces = [
        surface(1, 0),
        surface(2, x),
        surface(3, 700),
      ]
      const fused = frame(surfaces).find(item => item.label.endsWith(':2'))!
      expect(fused.label).toBe('volume-field:0:2')
      expect(fieldOf(fused)[3]).toBe(1)
      const passes = encode()
      expect(passes).toHaveLength(1)
      expect(passes[0]!.labels).toEqual(['volume-bake:2'])
      expect(groups.settling).toBe(true)
    }
    const rest = [
      surface(1, 0),
      surface(2, x),
      surface(3, 700),
    ]
    frame(rest)
    expect(encode()).toHaveLength(0)
    expect(groups.settling).toBe(false)
  })

  it('明显变化之后不等旧结果淡完：没有明显变化满规定时间就重新求交，从当前的比例接着淡入', () => {
    const { run, frameAt, now, encode, fieldOf } = setup()
    run(SETTLE_FRAMES + Math.ceil(FIELD_FLAP_MS / TICK), scene())
    const moved = [
      surface(1, 0),
      surface(2, 216),
      surface(3, 700),
    ]
    const tick = 1000 / 120
    const start = now()
    let bakeAt = -1
    let lowest = 1
    for (let i = 1; i <= Math.ceil(FIELD_SETTLE_MS / tick) + 2; i++) {
      const fused = frameAt(start + i * tick, moved).find(item => item.label.endsWith(':2'))!
      expect(fused.label).toBe('volume-field:0:2')
      lowest = Math.min(lowest, fieldOf(fused)[3]!)
      if (encode().length > 0 && bakeAt < 0)
        bakeAt = i
    }
    expect(bakeAt).toBe(Math.ceil((FIELD_SETTLE_MS + tick) / tick))
    expect(lowest).toBeGreaterThan(0)
    expect(lowest).toBeLessThan(1)
  })

  describe('局部失效', () => {
    const panel = (dx = 0): VolumeSurface[] => {
      const big = surface(1, 0, 180)
      big.width = 1200
      big.height = 120
      const left = surface(2, 20, 320)
      left.width = 100
      left.height = 60
      const right = surface(3, 1080 + dx, 320)
      right.width = 100
      right.height = 60
      return [big, left, right]
    }
    const fusedOf = <T extends { label: string }>(items: T[]): T => items.find(item => item.label.endsWith(':3'))!

    it('只有一块小玻璃移动时只让它附近失效：其余部分继续读缓存，停下后只重写那一块', () => {
      const { run, frame, encode, fieldOf, dirtyOf, fieldTextures } = setup()
      run(SETTLE_FRAMES + Math.ceil(FIELD_FLAP_MS / TICK), panel())
      const texture = fieldTextures().at(-1)!
      const moved = fusedOf(frame(panel(6)))
      expect(moved.label).toBe('volume-field:0:3')
      expect(encode()).toHaveLength(0)
      expect(fieldOf(moved)[3]).toBe(1)
      const [left, top, right, bottom, fade] = dirtyOf(moved)
      expect(fade!).toBeLessThan(1)
      expect(left!).toBeGreaterThan(120)
      expect(right!).toBeGreaterThan(1186)
      expect(top!).toBeLessThan(320)
      expect(bottom!).toBeGreaterThan(380)
      let partial: ReturnType<typeof encode>[number] | null = null
      for (let i = 0; i < Math.ceil(FIELD_SETTLE_MS / TICK) + 2 && !partial; i++) {
        frame(panel(6))
        partial = encode()[0] ?? null
      }
      expect(partial).not.toBeNull()
      expect(partial!.load).toEqual(['load', 'load', 'load'])
      expect(fieldTextures().at(-1)).toBe(texture)
      const settled = fusedOf(run(Math.ceil(FIELD_FADE_IN_MS / TICK) + 2, panel(6)))
      expect(dirtyOf(settled)[4]).toBe(1)
      expect(dirtyOf(settled)[2]!).toBeLessThan(dirtyOf(settled)[0]!)
    })

    it('移动的是面积最大的成员、或影响范围超过缓存的大半时整组作废', () => {
      const { run, frame, fieldOf } = setup()
      run(SETTLE_FRAMES + Math.ceil(FIELD_FLAP_MS / TICK), panel())
      const shifted = panel()
      shifted[0]!.left += 6
      expect(fieldOf(fusedOf(frame(shifted)))[3]).toBeLessThan(1)
    })

    it('刚写完缓存又明显移动时延长等待时间，轻微拖动不会在查表与缓存之间来回切换', () => {
      const { run, frame, encode } = setup()
      run(SETTLE_FRAMES + Math.ceil(FIELD_FLAP_MS / TICK), panel())
      const pause = (dx: number): number => {
        frame(panel(dx))
        encode()
        for (let i = 1; i < 60; i++) {
          frame(panel(dx))
          if (encode().length > 0)
            return i * TICK
        }
        return Infinity
      }
      const first = pause(6)
      const second = pause(12)
      expect(first).toBeLessThan(FIELD_SETTLE_MS + 2 * TICK)
      expect(second).toBeGreaterThanOrEqual(FIELD_SETTLE_MS * 2)
    })
  })

  it('尺寸、按压、材质化、圆角与截面参数变化都让缓存失效；外观变化不会', () => {
    const { run, frame, encode, fieldOf, dirtyOf } = setup()
    const base = (): VolumeSurface[] => scene()
    const settle = () => {
      run(Math.ceil((FIELD_SETTLE_MAX_MS + FIELD_FLAP_MS + FIELD_FADE_IN_MS) / TICK) + 3, base())
      expect(frame(base()).map(item => item.label)).toContain('volume-field:0:2')
    }
    const changes: ((surfaces: VolumeSurface[]) => void)[] = [
      (surfaces) => { surfaces[1]!.width = 220 },
      (surfaces) => { surfaces[0]!.press = 0.5 },
      (surfaces) => { surfaces[1]!.materialize = 0.7 },
      (surfaces) => {
        surfaces[0]!.options = {
          ...surfaces[0]!.options,
          radius: [8, 8, 8, 8],
        }
      },
      (surfaces) => { surfaces[0]!.options = { ...surfaces[0]!.options, bevelCurve: surfaces[0]!.options.bevelCurve + 0.5 } },
      (surfaces) => { surfaces[1]!.options = { ...surfaces[1]!.options, dispersion: surfaces[1]!.options.dispersion + 0.3 } },
      (surfaces) => { surfaces[0]!.fusion = surfaces[0]!.fusion - 4 },
    ]
    for (const change of changes) {
      settle()
      const changed = base()
      change(changed)
      const fused = frame(changed).find(item => item.label.endsWith(':2'))!
      expect(fused.label).toBe('volume-field:0:2')
      const passes = encode()
      if (Math.min(fieldOf(fused)[3]!, dirtyOf(fused)[4]!) < 1)
        expect(passes).toHaveLength(0)
      else
        expect(passes).toHaveLength(1)
    }

    settle()
    const tinted = base()
    tinted[0]!.opacity = 0.4
    tinted[1]!.brightness = 0.6
    tinted[0]!.options = {
      ...tinted[0]!.options,
      tintAlpha: 0.9,
      lens: 0.3,
      blur: 3,
    }
    expect(frame(tinted).map(item => item.label)).toContain('volume-field:0:2')
    expect(encode()).toHaveLength(0)
  })

  it('成员数量变化是另一组：新的组从查表开始，各有各的缓存', () => {
    const { run, frame, fieldTextures } = setup()
    run(SETTLE_FRAMES, scene())
    const three = [
      surface(1, 0),
      surface(2, 210),
      surface(4, 420),
      surface(3, 700),
    ]
    expect(frame(three).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:3'])
    expect(run(SETTLE_FRAMES, three).map(item => item.label).sort()).toEqual(['volume-field:0:3', 'volume-profile:0:1'])
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS * 2)
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS * 2)
  })

  it('着色倍率变化后重新求交，纹素数随倍率变化', () => {
    const { run, frame, encode, fieldTextures, data } = setup()
    run(SETTLE_FRAMES, scene())
    const full = fieldTextures()[0]!
    const half = { ...SHADING, scale: 0.5 }
    frame(scene(), half)
    expect(encode().at(-1)!.labels).toContain('volume-field:1:2')
    run(SETTLE_FRAMES + Math.ceil(FIELD_FADE_OUT_MS / TICK), scene(), half)
    const band = encode().at(-1)!
    const index = band.labels.indexOf('volume-field:1:2')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(data()[band.uniforms[index]! + HEADER_FLOATS + 14]).toBe(1)
    const textures = fieldTextures()
    expect(textures).toHaveLength(FIELD_TARGETS * 2)
    expect(textures.at(-1)!.width).toBeLessThan(full.width)
    expect(full.destroy.mock.calls).toHaveLength(1)
  })

  it('裁剪切进玻璃时单独一块也缓存；裁剪边远离玻璃时随滚动移动不影响缓存', () => {
    const { run, frame, encode, fieldTextures, fieldOf } = setup()
    const cut = (): VolumeSurface[] => [
      surface(1, 300, 200, [350, 0, 1000, 600]),
    ]
    expect(run(SETTLE_FRAMES, cut()).map(item => item.label)).toEqual(['volume-field:0:1'])
    const strip = fieldTextures()[0]!
    expect(strip.width).toBeLessThan(400)
    const shifted = [
      surface(1, 310, 200, [350, 0, 1000, 600]),
    ]
    const moved = frame(shifted)
    expect(moved.map(item => item.label)).toEqual(['volume-field:0:1'])
    expect(fieldOf(moved[0]!)[3]).toBeLessThan(1)

    const inside = (dy: number): VolumeSurface[] => [
      surface(5, 300, 250 + dy, [0, 0, 1000, 600]),
      surface(6, 510, 250 + dy, [0, 0, 1000, 600]),
    ]
    run(SETTLE_FRAMES, inside(0))
    for (const dy of [-20, -45, 30]) {
      expect(frame(inside(dy)).map(item => item.label)).toEqual(['volume-field:0:2'])
      expect(encode()).toHaveLength(0)
    }
  })

  it('圆角比倒角窄时单独一块也缓存，范围是整块玻璃；随滚动平移不影响缓存', () => {
    const { run, frame, encode, fieldTextures } = setup()
    const narrow = (dy = 0): VolumeSurface[] => {
      const glass = surface(1, 300, 200 + dy)
      glass.options = {
        ...glass.options,
        radius: [8, 8, 8, 8],
      }
      return [glass]
    }
    expect(run(SETTLE_FRAMES, narrow()).map(item => item.label)).toEqual(['volume-field:0:1'])
    const texture = fieldTextures()[0]!
    expect(texture.width).toBeGreaterThanOrEqual(400)
    expect(texture.height).toBeGreaterThanOrEqual(200)
    for (const dy of [-30, 15]) {
      expect(frame(narrow(dy)).map(item => item.label)).toEqual(['volume-field:0:1'])
      expect(encode()).toHaveLength(0)
    }
    const count = fieldTextures().length
    expect(run(SETTLE_FRAMES, [
      surface(2, 300),
    ]).map(item => item.label)).toEqual(['volume-profile:0:1'])
    expect(fieldTextures()).toHaveLength(count)
  })

  it('一帧最多写一组缓存，其余的顺延', () => {
    const { frameAt, now, encode } = setup()
    const two = [
      surface(1, 0),
      surface(2, 210),
      surface(3, 500, 400),
      surface(4, 710, 400),
    ]
    const start = now()
    frameAt(start, two)
    const first = frameAt(start + FIELD_SETTLE_MS, two).map(item => item.label).sort()
    expect(first).toEqual(['volume-field:0:2', 'volume-profile:0:2'])
    expect(encode()).toHaveLength(1)
    const second = frameAt(start + FIELD_SETTLE_MS + TICK, two).map(item => item.label)
    expect(second).toEqual(['volume-field:0:2', 'volume-field:0:2'])
    expect(encode()).toHaveLength(1)
    frameAt(start + FIELD_SETTLE_MS + TICK * 2, two)
    expect(encode()).toHaveLength(0)
  })

  it('超过纹素上限的组不缓存：静止后绑定空缓存，每帧逐步求交', () => {
    const { run, frame, encode, fieldTextures, bindGroups } = setup()
    const wide = (id: number, top: number): VolumeSurface => ({
      ...surface(id, 0, top),
      width: 4000,
      height: 300,
    })
    const huge = [
      wide(1, 0),
      wide(2, 310),
    ]
    const shading = { ...SHADING, cssWidth: 4000, pixelWidth: 8000 }
    const items = run(SETTLE_FRAMES, huge, shading)
    expect(items.map(item => item.label)).toEqual(['volume-field:0:2'])
    expect(fieldTextures()).toHaveLength(0)
    expect(fieldTextures(true)).toHaveLength(FIELD_TARGETS)
    expect(bindGroups.mock.calls.at(-1)![0].entries).toHaveLength(VOLUME_TEXTURES + 1 + FIELD_TARGETS)
    expect(encode()).toHaveLength(0)
    expect(frame(huge, shading).map(item => item.label)).toEqual(['volume-field:0:2'])
  })

  it('纹素总数超过上限时释放最久没有出现的组', () => {
    const { run, encode, fieldOf, fieldTextures, groups } = setup()
    const pair = (id: number): VolumeSurface[] => [
      {
        ...surface(id, 0, 100),
        width: 1000,
      },
      {
        ...surface(id + 1, 0, 210),
        width: 1000,
      },
    ]
    const shading = { ...SHADING, cssWidth: 1600, pixelWidth: 3200 }
    let texels = 0
    for (const id of [10, 20, 30, 40, 50]) {
      run(SETTLE_FRAMES, pair(id), shading)
      texels = fieldTextures()
        .filter(texture => texture.destroy.mock.calls.length === 0)
        .reduce((sum, texture) => sum + texture.width * texture.height, 0) / FIELD_TARGETS
      expect(texels).toBeLessThanOrEqual(FIELD_TEXEL_BUDGET)
      expect(texels).toBeGreaterThan(0)
    }
    expect(texels).toBeGreaterThan(FIELD_TEXEL_BUDGET / 2)
    const first = fieldTextures().slice(0, FIELD_TARGETS)
    expect(first.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
    const [returned] = run(1, pair(10), shading)
    expect(returned!.label).toBe('volume-field:0:2')
    expect(fieldOf(returned!)[3]).toBe(0)
    expect(encode().map(pass => pass.labels)).toEqual([
      ['volume-bake:2'],
    ])
    expect(groups.settling).toBe(true)
  })

  it('长时间没有出现的组释放纹理', () => {
    const { run, fieldTextures } = setup()
    run(SETTLE_FRAMES, scene())
    const textures = fieldTextures()
    const apart = [
      surface(1, 0),
      surface(2, 400),
      surface(3, 700),
    ]
    run(FIELD_IDLE_FRAMES, apart)
    expect(textures.every(texture => texture.destroy.mock.calls.length === 0)).toBe(true)
    run(3, apart)
    expect(textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
  })

  it('画进上层背景的那一次只读已有的缓存，不触发写入', () => {
    const { groups, gpu, encode, fieldTextures, now } = setup()
    const list = new DrawList()
    const limit = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
    }
    let time = now()
    const stacked = () => {
      time += TICK
      gpu.frame.begin()
      list.reset()
      groups.group(scene(), 3, 1000, 600, time)
      groups.setSource(0, {} as GPUTextureView)
      for (let i = 0; i < groups.groups.count; i++)
        groups.drawInto(list, groups.groups.plans[i]!, limit, 1000, 600, 1000, 600)
      return list.items.slice(0, list.count).map(item => String((item.pipeline as unknown as { label: string }).label)).sort()
    }
    for (let i = 0; i < SETTLE_FRAMES; i++)
      expect(stacked()).toEqual(['volume-profile:1:1', 'volume-profile:1:2'])
    expect(encode()).toHaveLength(0)
    expect(fieldTextures()).toHaveLength(0)
  })

  it('关闭缓存或换成别的光路后放弃缓存，融合的组每帧逐步求交', () => {
    const { run, frame, groups, fieldTextures } = setup()
    run(SETTLE_FRAMES, scene())
    const textures = fieldTextures()
    groups.setFieldCache(false)
    expect(textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-hybrid:0:2', 'volume-profile:0:1'])
    expect(groups.settling).toBe(false)
    groups.setFieldCache(true)
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    run(SETTLE_FRAMES, scene())
    const again = fieldTextures().slice(FIELD_TARGETS)
    expect(again).toHaveLength(FIELD_TARGETS)
    groups.setOptics('profile')
    expect(again.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    expect(groups.settling).toBe(false)
    groups.setOptics('raymarch')
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume:0:1', 'volume:0:2'])
  })

  it('预热混合光路时一并编译读写缓存的管线', () => {
    const { gpu, groups } = setup()
    const warmed: string[] = []
    gpu.compileAsync = (label: string) => {
      warmed.push(label)
      return null
    }
    groups.warm([2])
    expect(warmed.sort()).toEqual([
      'volume-bake:2',
      'volume-field:0:2',
      'volume-field:1:2',
      'volume-hybrid:0:2',
      'volume-hybrid:1:2',
      'volume-profile:0:2',
      'volume-profile:1:2',
    ])
  })
})

describe('拖尾的厚度', () => {
  it('按本体的尺寸与材质化算，与本体一致；没有指定时按自己的尺寸', () => {
    const body = surface(1, 0, 200)
    body.width = 64
    body.height = 64
    const tail = surface(-2, 10, 210)
    tail.width = 40
    tail.height = 40
    const own = volumeHalfDepth(tail)
    expect(own).toBeLessThan(volumeHalfDepth(body))
    tail.depthFrom = body
    expect(volumeHalfDepth(tail)).toBe(volumeHalfDepth(body))
    body.materialize = 0.5
    expect(volumeHalfDepth(tail)).toBe(volumeHalfDepth(body))
  })
})
