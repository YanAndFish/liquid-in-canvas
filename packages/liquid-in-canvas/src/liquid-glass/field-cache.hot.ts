import type { FrameEncoder } from '../frame.hot'
import type { StageGpu } from '../gpu'
import type { FieldEntry, FieldTextures } from './field-cache'
import type { StackMember } from './stack.hot'
import { DrawList } from '../frame.hot'
import {
  createEmptyField,
  createFieldEntry,
  createFieldTextures,
  FIELD_CLIP_FAR,
  FIELD_DRIFT,
  FIELD_ENTRIES,
  FIELD_FADE_IN_MS,
  FIELD_FADE_OUT_MS,
  FIELD_FADE_STEP_MS,
  FIELD_FLAP_MS,
  FIELD_IDLE_FRAMES,
  FIELD_MAX_MEMBERS,
  FIELD_SETTLE_MAX_MS,
  FIELD_SETTLE_MS,
  FIELD_SIZE_STEP,
  FIELD_TEXEL_BUDGET,
  FIELD_TOLERANCE,
} from './field-cache'
import { HYBRID_CLIP_PAD, hybridLateral } from './volume-hybrid-shader'
import { MEMBER_PROXIMITY, memberCornered } from './volume-members.hot'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from './volume-shader'

export interface ReachSource {
  reachOf: (row: number) => number
}

export interface FieldGroup {
  readonly members: readonly StackMember[]
  readonly count: number
}

const STILL = 0
const DRIFT = 1
const MOVED = 2

function put(signature: Float32Array, index: number, value: number, drift: number): number {
  const delta = Math.abs(signature[index]! - value)
  if (delta <= FIELD_TOLERANCE)
    return STILL
  signature[index] = value
  return delta <= drift
    ? DRIFT
    : MOVED
}

function settleFade(value: number): number {
  return value > 0.999
    ? 1
    : value < 0.001
      ? 0
      : value
}

function edge(near: boolean, position: number, far: number): number {
  return near
    ? position
    : far
}

export class FieldCache {
  readonly list = new DrawList()
  settling = false
  texels = 0
  private readonly gpu: StageGpu
  private readonly frame: FrameEncoder
  private readonly entries: FieldEntry[] = []
  private readonly empty: FieldTextures
  private readonly retired: GPUTexture[] = []
  private baking: FieldEntry | null = null
  private frameId = 0
  private now = 0
  private left = 0
  private top = 0
  private right = 0
  private bottom = 0

  constructor(gpu: StageGpu) {
    this.gpu = gpu
    this.frame = gpu.frame
    this.empty = createEmptyField(gpu)
    for (let i = 0; i < FIELD_ENTRIES; i++)
      this.entries.push(createFieldEntry())
  }

  begin(now: number): void {
    this.frameId++
    this.now = now
    this.settling = false
    this.baking = null
    this.list.reset()
    this.flush()
    const entries = this.entries
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (entry.used && this.frameId - entry.frame > FIELD_IDLE_FRAMES)
        this.forget(entry)
    }
  }

  track(plan: FieldGroup, data: Float32Array, group: number, profiles: ReachSource): FieldEntry | null {
    const count = plan.count
    if (count > FIELD_MAX_MEMBERS)
      return null
    const entry = this.find(plan) ?? this.claim(plan)
    if (entry === null || entry.frame === this.frameId)
      return entry
    entry.frame = this.frameId
    const members = group + VOLUME_GROUP_FLOATS
    const anchorX = data[members]!
    const anchorY = data[members + 1]!
    entry.anchorX = anchorX
    entry.anchorY = anchorY
    const signature = entry.signature
    let change = STILL
    let s = 0
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      const x = data[m]!
      const y = data[m + 1]!
      const halfWidth = data[m + 2]!
      const halfHeight = data[m + 3]!
      const halfDepth = data[m + 8]!
      change = Math.max(change, put(signature, s++, x - anchorX, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, y - anchorY, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, halfWidth, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, halfHeight, FIELD_DRIFT))
      for (let k = 4; k < 11; k++)
        change = Math.max(change, put(signature, s++, data[m + k]!, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, data[m + MEMBER_PROXIMITY]! * data[m + 10]!, FIELD_DRIFT))
      const pad = hybridLateral(profiles.reachOf(data[m + 28]!), halfDepth) + halfDepth + HYBRID_CLIP_PAD
      const clipLeft = data[m + 12]!
      const clipTop = data[m + 13]!
      const clipRight = data[m + 14]!
      const clipBottom = data[m + 15]!
      change = Math.max(change, put(signature, s++, edge(clipLeft > x - halfWidth - pad, clipLeft - anchorX, -FIELD_CLIP_FAR), FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, edge(clipTop > y - halfHeight - pad, clipTop - anchorY, -FIELD_CLIP_FAR), FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, edge(clipRight < x + halfWidth + pad, clipRight - anchorX, FIELD_CLIP_FAR), FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, edge(clipBottom < y + halfHeight + pad, clipBottom - anchorY, FIELD_CLIP_FAR), FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, data[m + 17]!, 0))
      change = Math.max(change, put(signature, s++, data[m + 32]!, 0))
      change = Math.max(change, put(signature, s++, data[m + 24]!, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, data[m + 25]!, FIELD_DRIFT))
      change = Math.max(change, put(signature, s++, data[m + 26]!, 0))
      change = Math.max(change, put(signature, s++, data[m + 27]!, FIELD_DRIFT))
    }
    if (change === MOVED)
      this.moved(entry)
    else if (change === DRIFT)
      entry.stale = true
    const step = Math.min(Math.max(this.now - entry.seenAt, 0), FIELD_FADE_STEP_MS)
    entry.seenAt = this.now
    entry.fade = settleFade(entry.live
      ? entry.fade + step / FIELD_FADE_IN_MS
      : entry.fade - step / FIELD_FADE_OUT_MS)
    if (change === STILL && entry.settle > FIELD_SETTLE_MS && entry.live && this.now - entry.bakedAt > FIELD_SETTLE_MAX_MS * 2)
      entry.settle = FIELD_SETTLE_MS
    if (!entry.live || entry.stale || entry.fade < 1)
      this.settling = true
    return entry
  }

  prepare(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource, ratio: number): boolean {
    if (this.baking !== null)
      return false
    if (entry.live) {
      if (entry.textures !== null && Math.abs(entry.ratio - ratio) > 1e-4) {
        this.invalidate(entry)
        this.settling = true
        return false
      }
      if (!entry.stale)
        return false
    }
    else if (this.now - entry.changedAt < entry.settle) {
      return false
    }
    entry.live = true
    entry.stale = false
    this.measure(data, group, count, profiles)
    if (this.right <= this.left || this.bottom <= this.top) {
      this.drop(entry)
      return false
    }
    const originX = Math.floor((entry.anchorX + this.left - 1) * ratio) / ratio
    const originY = Math.floor((entry.anchorY + this.top - 1) * ratio) / ratio
    const width = Math.ceil(Math.ceil((entry.anchorX + this.right + 1 - originX) * ratio) / FIELD_SIZE_STEP) * FIELD_SIZE_STEP
    const height = Math.ceil(Math.ceil((entry.anchorY + this.bottom + 1 - originY) * ratio) / FIELD_SIZE_STEP) * FIELD_SIZE_STEP
    const current = entry.textures
    if (current === null || current.width !== width || current.height !== height) {
      this.drop(entry)
      if (!this.reserve(width * height))
        return false
      entry.textures = createFieldTextures(this.gpu, width, height)
      entry.version++
      this.texels += width * height
    }
    entry.originX = originX - entry.anchorX
    entry.originY = originY - entry.anchorY
    entry.ratio = ratio
    entry.bakedAt = this.now
    entry.flapped = false
    this.baking = entry
    return true
  }

  texturesOf(entry: FieldEntry): FieldTextures {
    return entry.textures ?? this.empty
  }

  encode(encoder: GPUCommandEncoder): void {
    const entry = this.baking
    if (entry === null || entry.textures === null || this.list.count === 0)
      return
    const target = entry.textures
    this.frame.encodeFieldPass(encoder, target.views, target.width, target.height, this.list)
  }

  reset(): void {
    const entries = this.entries
    for (let i = 0; i < entries.length; i++)
      this.forget(entries[i]!)
    this.flush()
    this.baking = null
    this.list.reset()
    this.settling = false
  }

  dispose(): void {
    this.reset()
    const empty = this.empty.textures
    for (let i = 0; i < empty.length; i++)
      empty[i]!.destroy()
  }

  private moved(entry: FieldEntry): void {
    if (this.now - entry.bakedAt < FIELD_FLAP_MS && !entry.flapped) {
      entry.settle = Math.min(entry.settle * 2, FIELD_SETTLE_MAX_MS)
      entry.flapped = true
    }
    this.invalidate(entry)
  }

  private invalidate(entry: FieldEntry): void {
    entry.live = false
    entry.stale = false
    entry.changedAt = this.now
  }

  private flush(): void {
    const retired = this.retired
    for (let i = 0; i < retired.length; i++)
      retired[i]!.destroy()
    retired.length = 0
  }

  private find(plan: FieldGroup): FieldEntry | null {
    const entries = this.entries
    const members = plan.members
    const count = plan.count
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (!entry.used || entry.count !== count)
        continue
      const ids = entry.ids
      let same = true
      for (let j = 0; j < count; j++) {
        if (ids[j] !== members[j]!.id) {
          same = false
          break
        }
      }
      if (same)
        return entry
    }
    return null
  }

  private claim(plan: FieldGroup): FieldEntry | null {
    const entries = this.entries
    let chosen: FieldEntry | null = null
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (!entry.used) {
        chosen = entry
        break
      }
      if (entry.frame !== this.frameId && (chosen === null || entry.frame < chosen.frame))
        chosen = entry
    }
    if (chosen === null)
      return null
    this.forget(chosen)
    chosen.used = true
    chosen.count = plan.count
    for (let j = 0; j < plan.count; j++)
      chosen.ids[j] = plan.members[j]!.id
    chosen.signature.fill(Number.NaN)
    chosen.settle = FIELD_SETTLE_MS
    chosen.bakedAt = -Infinity
    chosen.flapped = false
    chosen.stale = false
    chosen.frame = -1
    chosen.seenAt = this.now
    chosen.changedAt = this.now
    return chosen
  }

  private measure(data: Float32Array, group: number, count: number, profiles: ReachSource): void {
    this.left = Infinity
    this.top = Infinity
    this.right = -Infinity
    this.bottom = -Infinity
    const members = group + VOLUME_GROUP_FLOATS
    const anchorX = data[members]!
    const anchorY = data[members + 1]!
    let lateral = 0
    let fusion = 0
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      lateral = Math.max(lateral, hybridLateral(profiles.reachOf(data[m + 28]!), data[m + 8]!))
      fusion = Math.max(fusion, data[m + 10]!)
    }
    const near = data[group + 3]! + lateral + 1
    const bulge = Math.min(near, fusion * (count - 1) / 2 + 2)
    for (let i = 0; i < count; i++) {
      const a = members + i * VOLUME_MEMBER_FLOATS
      const left = data[a]! - data[a + 2]! - anchorX
      const right = data[a]! + data[a + 2]! - anchorX
      const top = data[a + 1]! - data[a + 3]! - anchorY
      const bottom = data[a + 1]! + data[a + 3]! - anchorY
      const halfDepth = data[a + 8]!
      const cut = lateral + halfDepth + HYBRID_CLIP_PAD
      const inner = lateral + halfDepth + 2
      const clipLeft = data[a + 12]! - anchorX
      const clipTop = data[a + 13]! - anchorY
      const clipRight = data[a + 14]! - anchorX
      const clipBottom = data[a + 15]! - anchorY
      if (memberCornered(data, a))
        this.include(left, top, right, bottom)
      if (clipLeft > left - cut)
        this.include(left, top, Math.min(right, clipLeft + inner), bottom)
      if (clipRight < right + cut)
        this.include(Math.max(left, clipRight - inner), top, right, bottom)
      if (clipTop > top - cut)
        this.include(left, top, right, Math.min(bottom, clipTop + inner))
      if (clipBottom < bottom + cut)
        this.include(left, Math.max(top, clipBottom - inner), right, bottom)
      for (let j = i + 1; j < count; j++) {
        const b = members + j * VOLUME_MEMBER_FLOATS
        const otherLeft = data[b]! - data[b + 2]! - anchorX
        const otherRight = data[b]! + data[b + 2]! - anchorX
        const otherTop = data[b + 1]! - data[b + 3]! - anchorY
        const otherBottom = data[b + 1]! + data[b + 3]! - anchorY
        this.include(
          Math.max(left - bulge, otherLeft - near),
          Math.max(top - bulge, otherTop - near),
          Math.min(right + bulge, otherRight + near),
          Math.min(bottom + bulge, otherBottom + near),
        )
        this.include(
          Math.max(left - near, otherLeft - bulge),
          Math.max(top - near, otherTop - bulge),
          Math.min(right + near, otherRight + bulge),
          Math.min(bottom + near, otherBottom + bulge),
        )
      }
    }
  }

  private include(left: number, top: number, right: number, bottom: number): void {
    if (right <= left || bottom <= top)
      return
    this.left = Math.min(this.left, left)
    this.top = Math.min(this.top, top)
    this.right = Math.max(this.right, right)
    this.bottom = Math.max(this.bottom, bottom)
  }

  private reserve(texels: number): boolean {
    if (texels > FIELD_TEXEL_BUDGET)
      return false
    const entries = this.entries
    while (this.texels + texels > FIELD_TEXEL_BUDGET) {
      let victim: FieldEntry | null = null
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!
        if (entry.textures !== null && entry.frame !== this.frameId && (victim === null || entry.frame < victim.frame))
          victim = entry
      }
      if (victim === null)
        return false
      this.drop(victim)
      victim.live = false
      victim.stale = false
      victim.fade = 0
      victim.changedAt = this.now
    }
    return true
  }

  private drop(entry: FieldEntry): void {
    const textures = entry.textures
    if (textures === null)
      return
    for (let i = 0; i < textures.textures.length; i++)
      this.retired.push(textures.textures[i]!)
    this.texels -= textures.width * textures.height
    entry.textures = null
    entry.version++
  }

  private forget(entry: FieldEntry): void {
    this.drop(entry)
    entry.used = false
    entry.count = 0
    entry.live = false
    entry.stale = false
    entry.fade = 0
  }
}
