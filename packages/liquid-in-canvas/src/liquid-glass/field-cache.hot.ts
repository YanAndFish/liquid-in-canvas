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
  FIELD_LOCAL_LIMIT,
  FIELD_MAX_MEMBERS,
  FIELD_SETTLE_MAX_MS,
  FIELD_SETTLE_MS,
  FIELD_SIZE_STEP,
  FIELD_TEXEL_BUDGET,
  FIELD_TOLERANCE,
} from './field-cache'
import { FIELD_FEATHER, HYBRID_CLIP_PAD, hybridLateral } from './volume-hybrid-shader'
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

function unite(target: Float32Array, rect: Float32Array): void {
  target[0] = Math.min(target[0]!, rect[0]!)
  target[1] = Math.min(target[1]!, rect[1]!)
  target[2] = Math.max(target[2]!, rect[2]!)
  target[3] = Math.max(target[3]!, rect[3]!)
}

function largestMember(data: Float32Array, members: number, count: number): number {
  let best = 0
  let area = -1
  for (let i = 0; i < count; i++) {
    const m = members + i * VOLUME_MEMBER_FLOATS
    const size = data[m + 2]! * data[m + 3]!
    if (size > area) {
      area = size
      best = i
    }
  }
  return best
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
  bakeLeft = 0
  bakeTop = 0
  bakeRight = 0
  bakeBottom = 0
  private baking: FieldEntry | null = null
  private partial = false
  private readonly changes = new Uint8Array(FIELD_MAX_MEMBERS)
  private readonly scratch = new Float32Array(4)
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
    if (entry.anchor < 0)
      entry.anchor = largestMember(data, members, count)
    const a = members + entry.anchor * VOLUME_MEMBER_FLOATS
    const anchorX = data[a]!
    const anchorY = data[a + 1]!
    entry.anchorX = anchorX
    entry.anchorY = anchorY
    const signature = entry.signature
    const changes = this.changes
    let change = STILL
    let s = 0
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      const x = data[m]!
      const y = data[m + 1]!
      const halfWidth = data[m + 2]!
      const halfHeight = data[m + 3]!
      const halfDepth = data[m + 8]!
      let c = put(signature, s++, x - anchorX, FIELD_DRIFT)
      c = Math.max(c, put(signature, s++, y - anchorY, FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, halfWidth, FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, halfHeight, FIELD_DRIFT))
      for (let k = 4; k < 11; k++)
        c = Math.max(c, put(signature, s++, data[m + k]!, FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, data[m + MEMBER_PROXIMITY]! * data[m + 10]!, FIELD_DRIFT))
      const pad = hybridLateral(profiles.reachOf(data[m + 28]!), halfDepth) + halfDepth + HYBRID_CLIP_PAD
      const clipLeft = data[m + 12]!
      const clipTop = data[m + 13]!
      const clipRight = data[m + 14]!
      const clipBottom = data[m + 15]!
      c = Math.max(c, put(signature, s++, edge(clipLeft > x - halfWidth - pad, clipLeft - anchorX, -FIELD_CLIP_FAR), FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, edge(clipTop > y - halfHeight - pad, clipTop - anchorY, -FIELD_CLIP_FAR), FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, edge(clipRight < x + halfWidth + pad, clipRight - anchorX, FIELD_CLIP_FAR), FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, edge(clipBottom < y + halfHeight + pad, clipBottom - anchorY, FIELD_CLIP_FAR), FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, data[m + 17]!, 0))
      c = Math.max(c, put(signature, s++, data[m + 32]!, 0))
      c = Math.max(c, put(signature, s++, data[m + 24]!, FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, data[m + 25]!, FIELD_DRIFT))
      c = Math.max(c, put(signature, s++, data[m + 26]!, 0))
      c = Math.max(c, put(signature, s++, data[m + 27]!, FIELD_DRIFT))
      changes[i] = c
      change = Math.max(change, c)
    }
    if (change === MOVED)
      this.moved(entry, data, group, count, profiles)
    else if (change === DRIFT && entry.live)
      this.drifted(entry, data, group, count, profiles)
    const step = Math.min(Math.max(this.now - entry.seenAt, 0), FIELD_FADE_STEP_MS)
    entry.seenAt = this.now
    entry.fade = settleFade(entry.live
      ? entry.fade + step / FIELD_FADE_IN_MS
      : entry.fade - step / FIELD_FADE_OUT_MS)
    if (entry.dirty) {
      entry.dirtyFade = settleFade(entry.dirtyBaked
        ? entry.dirtyFade + step / FIELD_FADE_IN_MS
        : entry.dirtyFade - step / FIELD_FADE_OUT_MS)
      if (entry.dirtyBaked && entry.dirtyFade >= 1)
        entry.dirty = false
    }
    if (change === STILL && entry.settle > FIELD_SETTLE_MS && entry.live && !entry.dirty && this.now - entry.bakedAt > FIELD_SETTLE_MAX_MS * 2)
      entry.settle = FIELD_SETTLE_MS
    if (!entry.live || entry.stale || entry.dirty || entry.fade < 1)
      this.settling = true
    return entry
  }

  prepare(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource, ratio: number): boolean {
    if (this.baking !== null)
      return false
    let partial = false
    let settledDirty = false
    if (entry.live) {
      if (entry.textures !== null && Math.abs(entry.ratio - ratio) > 1e-4) {
        this.invalidate(entry)
        this.settling = true
        return false
      }
      settledDirty = entry.dirty && !entry.dirtyBaked && this.now - entry.dirtyChangedAt >= entry.settle
      if (!entry.stale && !settledDirty)
        return false
      partial = entry.textures !== null
    }
    else if (this.now - entry.changedAt < entry.settle) {
      return false
    }
    const refresh = entry.stale
    entry.live = true
    entry.stale = false
    this.measure(data, group, count, profiles, entry.anchor)
    if (this.right <= this.left || this.bottom <= this.top) {
      entry.dirty = false
      this.drop(entry)
      return false
    }
    const originX = Math.floor((entry.anchorX + this.left - 1) * ratio) / ratio
    const originY = Math.floor((entry.anchorY + this.top - 1) * ratio) / ratio
    const width = Math.ceil(Math.ceil((entry.anchorX + this.right + 1 - originX) * ratio) / FIELD_SIZE_STEP) * FIELD_SIZE_STEP
    const height = Math.ceil(Math.ceil((entry.anchorY + this.bottom + 1 - originY) * ratio) / FIELD_SIZE_STEP) * FIELD_SIZE_STEP
    const current = entry.textures
    if (partial && (current!.width !== width || current!.height !== height
      || Math.abs(entry.originX - (originX - entry.anchorX)) > 1e-3 || Math.abs(entry.originY - (originY - entry.anchorY)) > 1e-3)) {
      partial = false
    }
    if (!partial && (current === null || current.width !== width || current.height !== height)) {
      this.drop(entry)
      if (!this.reserve(width * height)) {
        entry.dirty = false
        return false
      }
      entry.textures = createFieldTextures(this.gpu, width, height)
      entry.version++
      this.texels += width * height
    }
    entry.originX = originX - entry.anchorX
    entry.originY = originY - entry.anchorY
    entry.ratio = ratio
    if (partial) {
      const rect = this.scratch
      rect[0] = Infinity
      rect[1] = Infinity
      rect[2] = -Infinity
      rect[3] = -Infinity
      if (refresh)
        unite(rect, entry.refreshRect)
      if (settledDirty)
        unite(rect, entry.dirtyRect)
      this.bakeLeft = Math.max(0, Math.floor((rect[0]! - entry.originX) * ratio))
      this.bakeTop = Math.max(0, Math.floor((rect[1]! - entry.originY) * ratio))
      this.bakeRight = Math.min(width, Math.ceil((rect[2]! - entry.originX) * ratio))
      this.bakeBottom = Math.min(height, Math.ceil((rect[3]! - entry.originY) * ratio))
      if (settledDirty)
        entry.dirtyBaked = true
    }
    else {
      this.bakeLeft = 0
      this.bakeTop = 0
      this.bakeRight = width
      this.bakeBottom = height
      entry.dirty = false
    }
    this.partial = partial
    this.recordBaked(entry, data, group, count)
    if (this.bakeRight <= this.bakeLeft || this.bakeBottom <= this.bakeTop)
      return false
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
    this.frame.encodeFieldPass(encoder, target.views, target.width, target.height, this.list, this.partial)
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

  private moved(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource): void {
    if (this.now - entry.bakedAt < FIELD_FLAP_MS && !entry.flapped) {
      entry.settle = Math.min(entry.settle * 2, FIELD_SETTLE_MAX_MS)
      entry.flapped = true
    }
    const textures = entry.textures
    if (!entry.live || textures === null || this.changes[entry.anchor] === MOVED) {
      this.invalidate(entry)
      return
    }
    const rect = this.scratch
    this.region(entry, data, group, count, profiles, MOVED, rect)
    const left = entry.originX
    const top = entry.originY
    const right = left + textures.width / entry.ratio
    const bottom = top + textures.height / entry.ratio
    const overlap = Math.max(0, Math.min(rect[2]!, right) - Math.max(rect[0]!, left))
      * Math.max(0, Math.min(rect[3]!, bottom) - Math.max(rect[1]!, top))
    if (overlap > FIELD_LOCAL_LIMIT * (right - left) * (bottom - top)) {
      this.invalidate(entry)
      return
    }
    if (!entry.dirty) {
      entry.dirty = true
      entry.dirtyFade = 1
      entry.dirtyRect.set(rect)
    }
    else {
      unite(entry.dirtyRect, rect)
    }
    entry.dirtyBaked = false
    entry.dirtyChangedAt = this.now
    this.drifted(entry, data, group, count, profiles)
  }

  private drifted(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource): void {
    const rect = this.scratch
    this.region(entry, data, group, count, profiles, DRIFT, rect)
    if (rect[2]! <= rect[0]!)
      return
    if (!entry.stale) {
      entry.stale = true
      entry.refreshRect.set(rect)
    }
    else {
      unite(entry.refreshRect, rect)
    }
  }

  private region(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource, level: number, target: Float32Array): void {
    const members = group + VOLUME_GROUP_FLOATS
    let lateral = 0
    let fusion = 0
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      lateral = Math.max(lateral, hybridLateral(profiles.reachOf(data[m + 28]!), data[m + 8]!))
      fusion = Math.max(fusion, data[m + 10]!)
    }
    const margin = Math.max(data[group + 3]! + lateral + 1, fusion * 2 + lateral) + FIELD_FEATHER + 2
    target[0] = Infinity
    target[1] = Infinity
    target[2] = -Infinity
    target[3] = -Infinity
    const baked = entry.baked
    for (let i = 0; i < count; i++) {
      if (this.changes[i] !== level)
        continue
      const m = members + i * VOLUME_MEMBER_FLOATS
      const x = data[m]! - entry.anchorX
      const y = data[m + 1]! - entry.anchorY
      const b = i * 4
      target[0] = Math.min(target[0]!, x - data[m + 2]!, baked[b]! - baked[b + 2]!) - margin
      target[1] = Math.min(target[1]!, y - data[m + 3]!, baked[b + 1]! - baked[b + 3]!) - margin
      target[2] = Math.max(target[2]!, x + data[m + 2]!, baked[b]! + baked[b + 2]!) + margin
      target[3] = Math.max(target[3]!, y + data[m + 3]!, baked[b + 1]! + baked[b + 3]!) + margin
    }
  }

  private invalidate(entry: FieldEntry): void {
    entry.live = false
    entry.stale = false
    entry.dirty = false
    entry.changedAt = this.now
  }

  private recordBaked(entry: FieldEntry, data: Float32Array, group: number, count: number): void {
    const members = group + VOLUME_GROUP_FLOATS
    const baked = entry.baked
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      baked[i * 4] = data[m]! - entry.anchorX
      baked[i * 4 + 1] = data[m + 1]! - entry.anchorY
      baked[i * 4 + 2] = data[m + 2]!
      baked[i * 4 + 3] = data[m + 3]!
    }
    entry.bakedAt = this.now
    entry.flapped = false
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
    chosen.anchor = -1
    chosen.settle = FIELD_SETTLE_MS
    chosen.bakedAt = -Infinity
    chosen.flapped = false
    chosen.dirty = false
    chosen.dirtyFade = 1
    chosen.stale = false
    chosen.frame = -1
    chosen.seenAt = this.now
    chosen.changedAt = this.now
    return chosen
  }

  private measure(data: Float32Array, group: number, count: number, profiles: ReachSource, anchor: number): void {
    this.left = Infinity
    this.top = Infinity
    this.right = -Infinity
    this.bottom = -Infinity
    const members = group + VOLUME_GROUP_FLOATS
    const anchorX = data[members + anchor * VOLUME_MEMBER_FLOATS]!
    const anchorY = data[members + anchor * VOLUME_MEMBER_FLOATS + 1]!
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
      victim.dirty = false
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
    entry.dirty = false
    entry.fade = 0
  }
}
