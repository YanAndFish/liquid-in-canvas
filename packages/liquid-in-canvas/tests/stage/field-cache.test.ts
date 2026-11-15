import type { BackdropBlur } from '../../src/liquid-glass/blur.hot'
import type { VolumeSurface } from '../../src/liquid-glass/fusion.hot'
import { describe, expect, it } from 'vitest'
import { HEADER_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { TARGET_FORMAT, TEXTURE_USAGE } from '../../src/gpu'
import { FIELD_FADE_IN_MS, FIELD_FADE_OUT_MS, FIELD_IDLE_FRAMES, FIELD_SETTLE_MS, FIELD_TEXEL_BUDGET } from '../../src/liquid-glass/field-cache'
import { parseGlassOptions } from '../../src/liquid-glass/options'
import { createFieldBakeShader, FIELD_TARGETS } from '../../src/liquid-glass/volume-field-shader'
import { createHybridVolumeShader } from '../../src/liquid-glass/volume-hybrid-shader'
import { createVolumeShader, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS, VOLUME_TEXTURES } from '../../src/liquid-glass/volume-shader'
import { VolumeGroups } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 没有裁剪祖先时的裁剪范围。 */
const UNCLIPPED = [-1e5, -1e5, 1e5, 1e5]

/** 创建一块 200 × 100 的玻璃。 */
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

/** 一帧的间隔，毫秒。 */
const TICK = 16

interface Item {
  label: string
  /** uniform 的起始下标（浮点数）。 */
  start: number
  textures: GPUBindGroup
}

/** 记录每一遍的附件与用到的管线的假编码器。 */
function fakeEncoder() {
  const passes: { views: unknown[], clear: unknown[], labels: string[], uniforms: number[] }[] = []
  const encoder = {
    beginRenderPass(descriptor: GPURenderPassDescriptor) {
      const attachments = [...descriptor.colorAttachments] as GPURenderPassColorAttachment[]
      const pass = {
        views: attachments.map(attachment => attachment.view),
        clear: attachments.map(attachment => attachment.clearValue),
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
  /** 在给定时间画一帧，返回画布遍里各组的绘制项。 */
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
  /** 过一帧的时间再画。 */
  const frame = (surfaces: VolumeSurface[], shading = SHADING): Item[] => frameAt(now + TICK, surfaces, shading)
  /** 连续画若干帧，返回最后一帧。 */
  const run = (frames: number, surfaces: VolumeSurface[], shading = SHADING): Item[] => {
    let items: Item[] = []
    for (let i = 0; i < frames; i++)
      items = frame(surfaces, shading)
    return items
  }
  /** 编码本帧的离屏绘制，返回各遍。 */
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
  /** 折射场纹理可以取样、写入，也可以直接上传（空缓存），用途与其他离屏目标和查找表都不同。 */
  const FIELD_USAGE = TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_DST
  /** 已创建的折射场纹理；`empty` 为 true 时返回 1 × 1 的空缓存。 */
  const fieldTextures = (empty = false) => createTexture.mock.results
    .map(result => result.value)
    .filter((texture, index) => {
      const [descriptor] = createTexture.mock.calls[index]!
      return descriptor.format === TARGET_FORMAT && descriptor.usage === FIELD_USAGE && (texture.width === 1) === empty
    })
  const bindGroups = fake.device.createBindGroup as unknown as { mock: { calls: [{ entries: { resource: unknown }[] }][] } }
  /** 一组的 uniform 里折射场的四个数：缓存左上角、倍率、求交结果的比例。 */
  const fieldOf = (item: Item) => {
    const at = item.start + HEADER_FLOATS + 12
    return [
      ...fake.gpu.frame.data.subarray(at, at + 4),
    ]
  }
  return {
    ...fake,
    groups,
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

/** 两块相连的玻璃和一块单独的玻璃。 */
function scene(dx = 0, dy = 0): VolumeSurface[] {
  return [
    surface(1, dx, 200 + dy),
    surface(2, 210 + dx, 200 + dy),
    surface(3, 700 + dx, 200 + dy),
  ]
}

/** 几何静止后画到求交结果完全淡入需要的帧数。 */
const SETTLE_FRAMES = Math.ceil((FIELD_SETTLE_MS + FIELD_FADE_IN_MS) / TICK) + 3

describe('折射场缓存的着色器', () => {
  it('写入缓存的着色器同时输出三张纹理，只追踪光路、不取样背景', () => {
    const code = createFieldBakeShader(2)
    expect(FIELD_TARGETS).toBe(3)
    expect(code.match(/@location\(\d\) \w+: vec4f/g)).toHaveLength(FIELD_TARGETS)
    const body = code.slice(code.indexOf('fn bake('))
    expect(body).toContain('glass_paths(entry.xyz')
    expect(body).not.toContain('sample_blur')
    expect(body).not.toContain('glass_shade')
    // 分档与混合着色器共用同一段代码。
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
    // 切换时与二维合并的查表结果交叉淡化。
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
      // 矩形与目标尺寸之后、成员之前的四个向量。
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
    // 第一帧：融合的组用剖面管线，要求继续重绘。
    expect(frameAt(start, scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    expect(groups.settling).toBe(true)
    expect(encode()).toHaveLength(0)
    expect(frameAt(start + FIELD_SETTLE_MS - 1, scene()).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])
    expect(fieldTextures()).toHaveLength(0)

    // 静止够久：这一帧写入缓存，并改用读缓存的管线；求交结果从零开始淡入。
    const items = frameAt(start + FIELD_SETTLE_MS, scene())
    expect(items.map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    const fused = items.find(item => item.label === 'volume-field:0:2')!
    const [originX, originY, ratio, fade] = fieldOf(fused)
    expect(ratio).toBe(2)
    expect(fade).toBe(0)
    // 缓存的左上角落在着色像素的边界上。
    expect(Number.isInteger(originX! * 2)).toBe(true)
    expect(Number.isInteger(originY! * 2)).toBe(true)
    const textures = fieldTextures()
    expect(textures).toHaveLength(FIELD_TARGETS)
    const passes = encode()
    expect(passes).toHaveLength(1)
    expect(passes[0]!.labels).toEqual(['volume-bake:2'])
    expect(passes[0]!.views).toHaveLength(FIELD_TARGETS)
    // 清成“没有光路”。
    expect(passes[0]!.clear[FIELD_TARGETS - 1]).toMatchObject({ a: -1 })
    const bake = pipelines.find(pipeline => pipeline.label === 'volume-bake:2')!
    expect([...bake.fragment!.targets].map(target => target!.format)).toEqual([TARGET_FORMAT, TARGET_FORMAT, TARGET_FORMAT])
    expect(groups.settling).toBe(true)

    // 之后的帧不再写入，只读缓存。
    frame(scene())
    expect(encode()).toHaveLength(0)
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS)
  })

  it('缓存只覆盖两块玻璃的连接处，纹素数按着色倍率分配', () => {
    const { run, fieldTextures } = setup()
    run(SETTLE_FRAMES, scene())
    const texture = fieldTextures()[0]!
    // 两块 200 × 100 的玻璃左右相距 10：缓存比整组的本体（410 × 100，@2 是 820 × 200）窄，
    // 高度只比玻璃多出平滑合并鼓出来的一圈。
    expect(texture.width).toBeGreaterThan(0)
    expect(texture.width).toBeLessThan(820)
    expect(texture.height).toBeLessThanOrEqual(288)
    expect(texture.width * texture.height).toBeLessThan(FIELD_TEXEL_BUDGET / 8)
  })

  it('写入缓存用的 uniform 把成员位置换成相对缓存左上角的坐标', () => {
    const { frameAt, now, encode, data, fieldOf, fieldTextures } = setup()
    const start = now()
    frameAt(start, scene())
    const items = frameAt(start + FIELD_SETTLE_MS, scene())
    const fused = items.find(item => item.label === 'volume-field:0:2')!
    const [originX, originY] = fieldOf(fused)
    const bake = encode()[0]!.uniforms[0]!
    const texture = fieldTextures()[0]!
    // 目标是缓存纹理：纹素尺寸，以及它在 CSS 像素里的大小。
    expect([
      ...data().subarray(bake + 4, bake + 8),
    ]).toEqual([
      texture.width,
      texture.height,
      texture.width / 2,
      texture.height / 2,
    ])
    const live = fused.start + HEADER_FLOATS + VOLUME_GROUP_FLOATS
    const baked = bake + HEADER_FLOATS + VOLUME_GROUP_FLOATS
    for (const member of [0, VOLUME_MEMBER_FLOATS]) {
      expect(data()[baked + member]).toBeCloseTo(data()[live + member]! - originX!, 3)
      expect(data()[baked + member + 1]).toBeCloseTo(data()[live + member + 1]! - originY!, 3)
      // 尺寸、圆角与厚度原样复制。
      for (let k = 2; k < 11; k++)
        expect(data()[baked + member + k]).toBe(data()[live + member + k])
    }
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
      expect(field[0]).toBeCloseTo(originX! + dx!, 3)
      expect(field[1]).toBeCloseTo(originY! + dy!, 3)
      expect(field[3]).toBe(1)
    }
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS)
    expect(groups.settling).toBe(false)
  })

  it('成员相对运动时缓存失效：上一次的结果淡出，随后用剖面管线，停下后重新求交', () => {
    const { run, frame, encode, fieldOf, fieldTextures, groups } = setup()
    run(SETTLE_FRAMES, scene())
    // 第二块玻璃每帧相对第一块移动 2 像素。
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
    // 淡出期间还读着旧缓存，比例逐帧下降。
    expect(fades[0]).toBeCloseTo(1 - TICK / FIELD_FADE_OUT_MS, 5)
    expect(fades.length).toBe(Math.ceil(FIELD_FADE_OUT_MS / TICK) - 1)
    expect(groups.settling).toBe(true)
    for (let i = 0; i < 3; i++)
      expect(frame(moving(++step)).map(item => item.label).sort()).toEqual(['volume-profile:0:1', 'volume-profile:0:2'])

    // 停下：先继续查表，静止够久后求交一次。
    const rest = moving(step)
    let bakes = 0
    for (let i = 0; i < SETTLE_FRAMES; i++) {
      frame(rest)
      bakes += encode().length
    }
    expect(bakes).toBe(1)
    expect(frame(rest).map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    // 连接处变宽后缓存换了一组更大的纹理，旧的已经释放。
    expect(fieldTextures().filter(texture => texture.destroy.mock.calls.length === 0)).toHaveLength(FIELD_TARGETS)
    expect(groups.settling).toBe(false)
  })

  it('尺寸、按压、材质化、圆角与截面参数变化都让缓存失效；外观变化不会', () => {
    const { run, frame, encode } = setup()
    const base = (): VolumeSurface[] => scene()
    const settle = () => {
      run(SETTLE_FRAMES, base())
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
      // 先把旧结果淡出，再用剖面管线。
      const labels = run(Math.ceil(FIELD_FADE_OUT_MS / TICK) + 1, changed).map(item => item.label)
      expect(labels).toContain('volume-profile:0:2')
      expect(labels).not.toContain('volume-field:0:2')
    }

    // 染色、不透明度、遮罩压暗与透镜强度每帧现算，不需要重新求交。
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
    // 回到两名成员：原来的缓存还在，直接命中。
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-field:0:2', 'volume-profile:0:1'])
    expect(fieldTextures()).toHaveLength(FIELD_TARGETS * 2)
  })

  it('着色倍率变化后重新求交，纹素数随倍率变化', () => {
    const { run, frame, encode, fieldTextures, data } = setup()
    run(SETTLE_FRAMES, scene())
    const full = fieldTextures()[0]!
    // 着色比例降到一半：体积改画进低分辨率的离屏目标，每个 CSS 像素一个着色像素。
    const half = { ...SHADING, scale: 0.5 }
    // 倍率刚变的那一帧还读着旧缓存，随后淡出、查表、重新求交。
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
    // 换下的纹理已经释放。
    expect(full.destroy.mock.calls).toHaveLength(1)
  })

  it('裁剪切进玻璃时单独一块也缓存；裁剪边远离玻璃时随滚动移动不影响缓存', () => {
    const { run, frame, encode, fieldTextures } = setup()
    // 裁剪边穿过玻璃：沿裁剪边的一条需要求交。
    const cut = (): VolumeSurface[] => [
      surface(1, 300, 200, [350, 0, 1000, 600]),
    ]
    expect(run(SETTLE_FRAMES, cut()).map(item => item.label)).toEqual(['volume-field:0:1'])
    const strip = fieldTextures()[0]!
    // 只缓存裁剪边内侧的一条，不是整块 200 × 100 的玻璃（@2 是 400 × 200）。
    expect(strip.width).toBeLessThan(400)
    // 玻璃相对裁剪边移动：缓存失效。
    const shifted = [
      surface(1, 310, 200, [350, 0, 1000, 600]),
    ]
    expect(run(Math.ceil(FIELD_FADE_OUT_MS / TICK) + 1, shifted).map(item => item.label)).toEqual(['volume-profile:0:1'])

    // 两块相连的玻璃在裁剪容器里滚动，裁剪边一直离得远：缓存保持命中。
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
    // 两块很大的玻璃上下相连，连接处横跨 4000 像素，@2 超过上限。
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
    // 绑定的最后三张是 1 × 1 的空缓存。
    expect(fieldTextures(true)).toHaveLength(FIELD_TARGETS)
    expect(bindGroups.mock.calls.at(-1)![0].entries).toHaveLength(VOLUME_TEXTURES + 1 + FIELD_TARGETS)
    expect(encode()).toHaveLength(0)
    expect(frame(huge, shading).map(item => item.label)).toEqual(['volume-field:0:2'])
  })

  it('纹素总数超过上限时释放最久没有出现的组', () => {
    const { run, encode, fieldOf, fieldTextures, groups } = setup()
    // 每组的连接处横跨 1500 像素：@2 时一份缓存约 90 万纹素，三份超过上限。
    const pair = (id: number): VolumeSurface[] => [
      {
        ...surface(id, 0, 100),
        width: 1500,
      },
      {
        ...surface(id + 1, 0, 210),
        width: 1500,
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
    }
    expect(texels).toBeGreaterThan(FIELD_TEXEL_BUDGET / 2)
    // 最早的一组已经被释放（纹理在之后的一帧销毁）。
    const first = fieldTextures().slice(0, FIELD_TARGETS)
    expect(first.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
    // 被释放的组再出现时重新求交，结果从零开始淡入（它的几何早已静止，不必再等）。
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
    // 两块玻璃分开，融合的组不再出现。
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
    /** 只分组并画进上层背景（CSS 分辨率），不做主绘制。 */
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
    // 关闭之后不会再有缓存的帧，纹理当场释放。
    expect(textures.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true)
    expect(frame(scene()).map(item => item.label).sort()).toEqual(['volume-hybrid:0:2', 'volume-profile:0:1'])
    expect(groups.settling).toBe(false)
    groups.setFieldCache(true)
    // 重新打开：从查表开始。
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
