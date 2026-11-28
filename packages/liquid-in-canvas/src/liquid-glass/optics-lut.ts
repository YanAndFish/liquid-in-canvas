import type { StageGpu } from '../gpu'
import { TEXTURE_USAGE } from '../gpu'
import { BASE_IOR } from './profile'

export const LUT_SAMPLES = 128
export const LUT_ROWS_PER_PROFILE = 4
const LUT_CAPACITY_STEP = 16
export const DISPERSION_SPREAD = 0.055
const REFERENCE_HALF_DEPTH = 24
export const MAX_TRAVEL = 800

export interface ProfileKey {
  bevelWidth: number
  bevelHeight: number
  curve: number
  bottomBevel: number
  dispersion: number
  ior: number
}

export interface ProfileSample {
  shift: [number, number, number]
  slope: [number, number, number]
  valid: [number, number, number]
  normal: [number, number]
  hit: number
  reach: number
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

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
  const iors = [key.ior - spread, key.ior, key.ior + spread]
  const samples: ProfileSample[] = []
  for (let i = 0; i < LUT_SAMPLES; i++) {
    const s = (i / (LUT_SAMPLES - 1)) ** 2
    const u0 = -s * bevelWidth
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
      reach: 0,
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
        sample.reach = Math.max(sample.reach, Math.abs(pu - u0) / hd)
        const d = field(pu, pz)
        if (d > -0.025) {
          const [ou, oz] = normal(pu, pz)
          const [gu, gz] = refract(du, dz, -ou, -oz, iors[c]!)
          if (gu * gu + gz * gz > 0.01) {
            const slope = gu / Math.max(-gz, 0.02)
            sample.slope[c] = slope
            sample.shift[c] = (pu - u0 + Math.max(pz, 0) * slope) / hd
            sample.valid[c] = smoothstep(0.06, 0.22, -gz)
            done = true
            break
          }
          if (bounced)
            break
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
      sample.reach = Math.max(sample.reach, Math.abs(pu - u0) / hd)
      if (!done) {
        sample.shift[c] = (pu - u0) / hd
        sample.slope[c] = 0
        sample.valid[c] = 0
      }
    }
  }
  return samples
}

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

export function encodeProfile(samples: readonly ProfileSample[]): Uint16Array {
  const data = new Uint16Array(LUT_SAMPLES * 4 * LUT_ROWS_PER_PROFILE)
  const row = LUT_SAMPLES * 4
  samples.forEach((sample, i) => {
    const reach = Math.max(samples[i - 1]?.reach ?? 0, sample.reach, samples[i + 1]?.reach ?? 0)
    const values = [
      [...sample.shift, sample.normal[0]],
      [...sample.slope, sample.normal[1]],
      [...sample.valid, sample.hit],
      [reach, 0, 0, 0],
    ]
    values.forEach((texel, r) => {
      texel.forEach((value, c) => {
        data[r * row + i * 4 + c] = toHalf(value)
      })
    })
  })
  return data
}

function keyOf(key: ProfileKey): number {
  const q = (value: number, scale: number, max: number): number => Math.min(max, Math.max(0, Math.round(value * scale)))
  return ((((q(key.bevelWidth, 64, 4095) * 4096 + q(key.bevelHeight, 64, 127)) * 128 + q(key.curve, 16, 255)) * 256 + q(key.bottomBevel, 32, 63)) * 64 + q(key.dispersion, 32, 63)) * 128 + q(key.ior - 1, 64, 127)
}

export class ProfileTable {
  generation = 0
  private readonly gpu: StageGpu | null
  private readonly rows = new Map<number, number>()
  private readonly encoded: Uint16Array[] = []
  private readonly reaches: number[] = []
  private readonly retired: GPUTexture[] = []
  private texture: GPUTexture | null = null
  private textureView: GPUTextureView | null = null
  private capacity = 0
  private readonly scratch: ProfileKey = {
    bevelWidth: 0,
    bevelHeight: 0,
    curve: 0,
    bottomBevel: 0,
    dispersion: 0,
    ior: BASE_IOR,
  }

  constructor(gpu: StageGpu | null) {
    this.gpu = gpu
  }

  get view(): GPUTextureView {
    if (!this.textureView)
      this.grow(LUT_CAPACITY_STEP)
    return this.textureView!
  }

  get size(): number {
    return this.encoded.length
  }

  rowOf(bevelWidth: number, bevelHeight: number, curve: number, bottomBevel: number, dispersion: number, ior = BASE_IOR): number {
    const key = this.scratch
    key.bevelWidth = bevelWidth
    key.bevelHeight = bevelHeight
    key.curve = curve
    key.bottomBevel = bottomBevel
    key.dispersion = dispersion
    key.ior = ior
    const id = keyOf(key)
    const row = this.rows.get(id)
    if (row !== undefined)
      return row
    return this.add(id, key)
  }

  reachOf(row: number): number {
    return this.reaches[row]!
  }

  release(): void {
    for (let i = 0; i < this.retired.length; i++)
      this.retired[i]!.destroy()
    this.retired.length = 0
  }

  dispose(): void {
    this.release()
    this.texture?.destroy()
    this.texture = null
    this.textureView = null
  }

  private add(id: number, key: ProfileKey): number {
    const row = this.encoded.length
    const samples = traceProfile({ ...key })
    this.encoded.push(encodeProfile(samples))
    this.reaches.push(samples.reduce((reach, sample) => Math.max(reach, sample.reach), 0))
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
    if (this.texture)
      this.retired.push(this.texture)
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
