/**
 * 剖面光学的查找表：沿玻璃截面预先追踪光路，体积着色器按到轮廓的距离直接查表。
 *
 * 三维实体是“平面距离 → 截面高度”的旋转体：法线只在 (平面距离梯度, z) 平面内倾斜，
 * 正交入射的光线折射后也留在这个平面里。所以一条截面上的二维追踪就给出了任意位置的出射偏移，
 * 每个像素不再需要逐步求交。这里的追踪逐条照搬 `volume-shader.ts` 的求交、法线与出射，
 * 单块玻璃上两条路径的结果一致；融合连接处与小圆角拐角里光线会离开截面平面，那里是近似。
 *
 * 本文件是冷路径：只在出现新的截面参数时追踪并上传一行。
 */
import type { StageGpu } from '../gpu'
import { TEXTURE_USAGE } from '../gpu'

/** 每行的采样数。 */
export const LUT_SAMPLES = 128
/** 每行在纹理里占的纹素行数：位移、斜率、有效度各一行。 */
export const LUT_ROWS_PER_PROFILE = 3
/** 纹理按这个行数扩容。 */
const LUT_CAPACITY_STEP = 16
/** 中间那条光路的折射率，与体积着色器一致。 */
export const BASE_IOR = 1.45
/** 色散在折射率上的跨度，与体积着色器一致。 */
export const DISPERSION_SPREAD = 0.055
/** 追踪时使用的参考半厚度，结果再按它归一化。阈值与步长以像素为单位，和着色器保持一致。 */
const REFERENCE_HALF_DEPTH = 24
/** 平板之外的取样偏移被限制在这个距离以内，与着色器的 `min(travel, 800)` 一致。 */
export const MAX_TRAVEL = 800

/** 决定一行查找表的截面参数，长度都按半厚度归一化。 */
export interface ProfileKey {
  /** 实际倒角宽度与半厚度之比（已按控件尺寸限制）。 */
  bevelWidth: number
  /** 实际倒角高度与半厚度之比。 */
  bevelHeight: number
  /** 倒角曲线的超椭圆指数。 */
  curve: number
  /** 底面倒角比例。 */
  bottomBevel: number
  /** 色散强度。 */
  dispersion: number
}

/**
 * 截面上一个位置的追踪结果，长度按半厚度归一化。
 *
 * 取样位置 = 像素 + 外法向 ×（半厚度 × `shift` + 底面高度 × `slope`），三条光路分别给出。
 */
export interface ProfileSample {
  /** 玻璃内与底面以下（到底面平面为止）的横向位移，向外为正。 */
  shift: [number, number, number]
  /** 出射光线每下降一个单位的横向位移，向外为正。 */
  slope: [number, number, number]
  /** 光路有效度，与着色器的 `smoothstep(0.02, 0.14, -outgoing.z)` 相同。 */
  valid: [number, number, number]
  /** 入射点法线在外法向与 z 上的分量。 */
  normal: [number, number]
  /** 入射求交是否命中。 */
  hit: number
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 截面上的二维距离场：u 是到轮廓的有向距离（向外为正），z 是到底面的高度，单位为像素。 */
function sectionDistance(u: number, z: number, halfDepth: number, bevelWidth: number, bevelHeight: number, power: number, bottom: number): number {
  const height = z - halfDepth
  const scale = height > 0
    ? 1
    : bottom
  const bx = Math.max(bevelWidth * scale, 0.5)
  const by = Math.max(bevelHeight * scale, 0.5)
  const ux = (u + bx) / bx
  const uy = (Math.abs(height) - halfDepth + by) / by
  const px = Math.max(ux, 0)
  const py = Math.max(uy, 0)
  const rounded = (px ** power + py ** power) ** (1 / power)
  const lipschitz = Math.min(1, 2 ** (0.5 - 1 / power))
  const curved = (rounded + Math.min(Math.max(ux, uy), 0) - 1) * Math.min(bx, by) * lipschitz
  return Math.max(curved, Math.max(u, Math.abs(height) - halfDepth))
}

function refract(ix: number, iz: number, nx: number, nz: number, eta: number): [number, number] {
  const cos = nx * ix + nz * iz
  const k = 1 - eta * eta * (1 - cos * cos)
  if (k < 0)
    return [0, 0]
  const factor = eta * cos + Math.sqrt(k)
  return [eta * ix - factor * nx, eta * iz - factor * nz]
}

/**
 * 沿截面追踪 `LUT_SAMPLES` 个位置。第 i 个样本到轮廓的距离是倒角宽度的 (i / (N − 1))² 倍，
 * 在陡峭的轮廓附近采得更密；着色器按平方根换算回查表坐标。
 */
export function traceProfile(key: ProfileKey): ProfileSample[] {
  const hd = REFERENCE_HALF_DEPTH
  const bevelWidth = Math.max(0.5, key.bevelWidth * hd)
  const bevelHeight = Math.min(hd, Math.max(0.5, key.bevelHeight * hd))
  const power = key.curve
  const bottom = key.bottomBevel
  const field = (u: number, z: number): number => sectionDistance(u, z, hd, bevelWidth, bevelHeight, power, bottom)
  const normal = (u: number, z: number): [number, number] => {
    const e = 0.08
    const x = field(u + e, z) - field(u - e, z)
    const y = field(u, z + e) - field(u, z - e) + 0.00001
    const length = Math.hypot(x, y)
    return [x / length, y / length]
  }
  const spread = key.dispersion * DISPERSION_SPREAD
  const iors = [BASE_IOR - spread, BASE_IOR, BASE_IOR + spread]
  const samples: ProfileSample[] = []
  for (let i = 0; i < LUT_SAMPLES; i++) {
    const s = (i / (LUT_SAMPLES - 1)) ** 2
    const u0 = -s * bevelWidth
    // 入射：正交光线自上而下。
    let z = hd * 2 + 4
    let hit = 0
    for (let step = 0; step < 64; step++) {
      const d = field(u0, z)
      if (d < 0.02) {
        hit = 1
        break
      }
      z -= Math.max(d * 0.85, 0.025)
      if (z < 0)
        break
    }
    const sample: ProfileSample = {
      shift: [0, 0, 0],
      slope: [0, 0, 0],
      valid: [1, 1, 1],
      normal: [0, 1],
      hit,
    }
    samples.push(sample)
    if (!hit)
      continue
    const [nu, nz] = normal(u0, z)
    sample.normal = [nu, nz]
    for (let c = 0; c < 3; c++) {
      let [du, dz] = refract(0, -1, nu, nz, 1 / iors[c]!)
      let pu = u0 + du * 0.12
      let pz = z + dz * 0.12
      let bounced = false
      let done = false
      for (let step = 0; step < 64; step++) {
        const d = field(pu, pz)
        if (d > -0.025) {
          const [ou, oz] = normal(pu, pz)
          const [gu, gz] = refract(du, dz, -ou, -oz, iors[c]!)
          if (gu * gu + gz * gz > 0.01) {
            const slope = gu / Math.max(-gz, 0.02)
            sample.slope[c] = slope
            sample.shift[c] = (pu - u0 + Math.max(pz, 0) * slope) / hd
            sample.valid[c] = smoothstep(0.02, 0.14, -gz)
            done = true
            break
          }
          if (bounced)
            break
          // 全内反射一次。
          const dot = du * ou + dz * oz
          du -= 2 * dot * ou
          dz -= 2 * dot * oz
          pu += du * 0.5
          pz += dz * 0.5
          bounced = true
        }
        else {
          const step = Math.max(-d * 0.85, 0.035)
          pu += du * step
          pz += dz * step
        }
      }
      if (!done) {
        sample.shift[c] = (pu - u0) / hd
        sample.slope[c] = 0
        sample.valid[c] = 0
      }
    }
  }
  return samples
}

/** 单精度浮点转半精度，用于写入 `rgba16float` 纹理。 */
export function toHalf(value: number): number {
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  f32[0] = value
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const exponent = ((x >>> 23) & 0xFF) - 127 + 15
  const mantissa = x & 0x7FFFFF
  if (exponent <= 0)
    return sign
  if (exponent >= 31)
    return sign | 0x7BFF
  return sign | (exponent << 10) | (mantissa >>> 13)
}

/** 把一行的追踪结果编成三行半精度纹素：位移、斜率、有效度；第四个分量依次是法线的两个分量与命中。 */
export function encodeProfile(samples: readonly ProfileSample[]): Uint16Array {
  const data = new Uint16Array(LUT_SAMPLES * 4 * LUT_ROWS_PER_PROFILE)
  const row = LUT_SAMPLES * 4
  samples.forEach((sample, i) => {
    const values = [
      [...sample.shift, sample.normal[0]],
      [...sample.slope, sample.normal[1]],
      [...sample.valid, sample.hit],
    ]
    values.forEach((texel, r) => {
      texel.forEach((value, c) => {
        data[r * row + i * 4 + c] = toHalf(value)
      })
    })
  })
  return data
}

/** 截面参数量化后的整数键。 */
function keyOf(key: ProfileKey): number {
  const q = (value: number, scale: number, max: number): number => Math.min(max, Math.max(0, Math.round(value * scale)))
  return (((q(key.bevelWidth, 64, 4095) * 4096 + q(key.bevelHeight, 64, 127)) * 128 + q(key.curve, 16, 255)) * 256 + q(key.bottomBevel, 32, 63)) * 64 + q(key.dispersion, 32, 63)
}

/**
 * 查找表纹理：每种截面参数一行（三条纹素行），按需追踪并上传。
 *
 * `rowOf()` 在每帧写 uniform 时调用：参数已有对应行时只是一次 Map 查询，
 * 出现新参数时追踪一行并写入纹理，容量不够时换一张更大的纹理（`generation` 加一）。
 */
export class ProfileTable {
  /** 纹理被重新创建时加一，绑定需要随之重建。 */
  generation = 0
  private readonly gpu: StageGpu | null
  private readonly rows = new Map<number, number>()
  private readonly encoded: Uint16Array[] = []
  private texture: GPUTexture | null = null
  private textureView: GPUTextureView | null = null
  private capacity = 0
  private readonly scratch: ProfileKey = {
    bevelWidth: 0,
    bevelHeight: 0,
    curve: 0,
    bottomBevel: 0,
    dispersion: 0,
  }

  /** 没有 GPU（单元测试）时只记录行号。 */
  constructor(gpu: StageGpu | null) {
    this.gpu = gpu
  }

  /** 当前纹理视图；还没有任何一行时先创建一张空纹理。 */
  get view(): GPUTextureView {
    if (!this.textureView)
      this.grow(LUT_CAPACITY_STEP)
    return this.textureView!
  }

  /** 已经追踪的行数。 */
  get size(): number {
    return this.encoded.length
  }

  /** 取得截面参数对应的行号，没有时追踪并上传。 */
  rowOf(bevelWidth: number, bevelHeight: number, curve: number, bottomBevel: number, dispersion: number): number {
    const key = this.scratch
    key.bevelWidth = bevelWidth
    key.bevelHeight = bevelHeight
    key.curve = curve
    key.bottomBevel = bottomBevel
    key.dispersion = dispersion
    const id = keyOf(key)
    const row = this.rows.get(id)
    if (row !== undefined)
      return row
    return this.add(id, key)
  }

  dispose(): void {
    this.texture?.destroy()
    this.texture = null
    this.textureView = null
  }

  private add(id: number, key: ProfileKey): number {
    const row = this.encoded.length
    this.encoded.push(encodeProfile(traceProfile({ ...key })))
    this.rows.set(id, row)
    if (row + 1 > this.capacity)
      this.grow(this.capacity + LUT_CAPACITY_STEP)
    else
      this.upload(row)
    return row
  }

  private grow(capacity: number): void {
    this.capacity = capacity
    this.generation++
    if (!this.gpu)
      return
    this.texture?.destroy()
    this.texture = this.gpu.device.createTexture({
      size: { width: LUT_SAMPLES, height: capacity * LUT_ROWS_PER_PROFILE },
      format: 'rgba16float',
      usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
    })
    this.textureView = this.texture.createView()
    for (let row = 0; row < this.encoded.length; row++)
      this.upload(row)
  }

  private upload(row: number): void {
    if (!this.gpu || !this.texture)
      return
    const data = this.encoded[row]!
    this.gpu.device.queue.writeTexture(
      {
        texture: this.texture,
        origin: { x: 0, y: row * LUT_ROWS_PER_PROFILE },
      },
      data,
      { bytesPerRow: LUT_SAMPLES * 8, rowsPerImage: LUT_ROWS_PER_PROFILE },
      { width: LUT_SAMPLES, height: LUT_ROWS_PER_PROFILE },
    )
  }
}
