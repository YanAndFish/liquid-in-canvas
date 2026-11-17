import type { StageGpu } from '../gpu'
import type { VolumeTextures } from './volume-shader'
import { TEXTURE_USAGE } from '../gpu'
import { FIELD_FORMATS } from './volume-field-shader'
import { bindVolumeTextures } from './volume-shader'

export const FIELD_MAX_MEMBERS = 8
export const FIELD_ENTRIES = 12
export const FIELD_SIGNATURE_FLOATS = 22
export const FIELD_TOLERANCE = 0.01
export const FIELD_DRIFT = 1.5
export const FIELD_SETTLE_MS = 50
export const FIELD_SETTLE_MAX_MS = 400
export const FIELD_FLAP_MS = 400
export const FIELD_FADE_IN_MS = 100
export const FIELD_FADE_OUT_MS = 80
export const FIELD_FADE_STEP_MS = 34
export const FIELD_TEXEL_BUDGET = 1_500_000
export const FIELD_IDLE_FRAMES = 180
export const FIELD_SIZE_STEP = 32
export const FIELD_CLIP_FAR = 1e6

export interface FieldTextures {
  readonly textures: GPUTexture[]
  readonly views: GPUTextureView[]
  readonly width: number
  readonly height: number
}

export interface FieldEntry {
  used: boolean
  readonly ids: Int32Array
  count: number
  readonly signature: Float32Array
  frame: number
  seenAt: number
  changedAt: number
  live: boolean
  stale: boolean
  fade: number
  anchorX: number
  anchorY: number
  bakedAt: number
  settle: number
  flapped: boolean
  originX: number
  originY: number
  ratio: number
  textures: FieldTextures | null
  version: number
  readonly bound: FieldBinding
}

export interface FieldBinding extends VolumeTextures {
  source: GPUTextureView | null
  version: number
}

export function createFieldEntry(): FieldEntry {
  return {
    used: false,
    ids: new Int32Array(FIELD_MAX_MEMBERS),
    count: 0,
    signature: new Float32Array(FIELD_MAX_MEMBERS * FIELD_SIGNATURE_FLOATS),
    frame: -1,
    seenAt: 0,
    changedAt: 0,
    live: false,
    stale: false,
    fade: 0,
    anchorX: 0,
    anchorY: 0,
    bakedAt: -Infinity,
    settle: FIELD_SETTLE_MS,
    flapped: false,
    originX: 0,
    originY: 0,
    ratio: 1,
    textures: null,
    version: 0,
    bound: {
      source: null,
      version: -1,
      generation: -1,
      group: null as unknown as GPUBindGroup,
    },
  }
}

export function createFieldTextures(gpu: StageGpu, width: number, height: number): FieldTextures {
  const textures = FIELD_FORMATS.map(format => gpu.device.createTexture({
    size: { width, height },
    format,
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_DST,
  }))
  return {
    textures,
    views: textures.map(texture => texture.createView()),
    width,
    height,
  }
}

const HALF_MINUS_ONE = 0xBC00

export function createEmptyField(gpu: StageGpu): FieldTextures {
  const field = createFieldTextures(gpu, 1, 1)
  gpu.device.queue.writeTexture(
    { texture: field.textures[FIELD_FORMATS.length - 1]! },
    new Uint16Array([0, 0, 0, HALF_MINUS_ONE]),
    { bytesPerRow: 8 },
    { width: 1, height: 1 },
  )
  return field
}

export function bindFieldTextures(
  gpu: StageGpu,
  entry: FieldEntry,
  source: GPUTextureView,
  blurs: readonly GPUTextureView[],
  generation: number,
  lut: GPUTextureView,
  fields: FieldTextures,
): GPUBindGroup {
  const bound = entry.bound
  bound.source = source
  bound.version = entry.version
  bound.generation = generation
  bound.group = bindVolumeTextures(gpu, source, blurs, generation, lut, fields.views).group
  return bound.group
}
