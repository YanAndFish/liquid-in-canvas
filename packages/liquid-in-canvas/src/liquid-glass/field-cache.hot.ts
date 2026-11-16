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

/** 查找表里一行的光线在玻璃内的最大横向位移，与半厚度之比。由 `ProfileTable` 实现。 */
export interface ReachSource {
  reachOf: (row: number) => number
}

/** 一组里缓存要认的部分：成员编号。由 `VolumeGroupPlan` 实现。 */
export interface FieldGroup {
  readonly members: readonly StackMember[]
  readonly count: number
}

/** 几何特征没有变化、小幅漂移与明显变化，见 `put()`。 */
const STILL = 0
const DRIFT = 1
const MOVED = 2

/**
 * 写入一项几何特征，返回变化的程度：不超过容差是 `STILL`，不超过 `drift` 是 `DRIFT`，更大是 `MOVED`。
 * 没有写过的位置是 NaN，一定算 `MOVED`。没有长度单位的特征（色散、曲线指数）传 0，任何变化都算 `MOVED`。
 */
function put(signature: Float32Array, index: number, value: number, drift: number): number {
  const delta = Math.abs(signature[index]! - value)
  if (delta <= FIELD_TOLERANCE)
    return STILL
  signature[index] = value
  return delta <= drift
    ? DRIFT
    : MOVED
}

/** 淡化进度限制在 0–1，留一点余量：逐帧累加的舍入误差不该让淡化多拖一帧。 */
function settleFade(value: number): number {
  return value > 0.999
    ? 1
    : value < 0.001
      ? 0
      : value
}

/** 把矩形 `rect`（左、上、右、下）并入 `target`。 */
function unite(target: Float32Array, rect: Float32Array): void {
  target[0] = Math.min(target[0]!, rect[0]!)
  target[1] = Math.min(target[1]!, rect[1]!)
  target[2] = Math.max(target[2]!, rect[2]!)
  target[3] = Math.max(target[3]!, rect[3]!)
}

/** 面积最大的成员，作为缓存的原点：它通常静止，别的成员移动时缓存可以只局部失效。 */
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

/** 一条裁剪边在几何特征里的值：切进玻璃时是它的相对位置，否则是固定的远处。 */
function edge(near: boolean, position: number, far: number): number {
  return near
    ? position
    : far
}

/**
 * 混合光路的折射场缓存：几何静止的组只求交一次，之后每帧读回折射场，照常取样背景。
 *
 * 每个条目对应一组玻璃（按成员编号认），记录这组成员相对第一名成员的几何特征。每帧写完
 * 这一组的 uniform 之后 `track()` 比较特征：
 *
 * - 明显变化（成员相对运动、尺寸、圆角、厚度、截面、按压与材质化、裁剪切进玻璃的位置、色散）：
 *   缓存作废，这一组改用剖面管线查表，上一次的求交结果在 `FIELD_FADE_OUT_MS` 里淡出。
 * - 没有明显变化满 `FIELD_SETTLE_MS`：`prepare()` 安排求交一次、写进缓存，之后用读缓存的管线，
 *   求交结果在 `FIELD_FADE_IN_MS` 里淡入。整组平移（随页面滚动）不改变特征，缓存一直有效。
 * - 长度类特征每次变化不超过 `FIELD_DRIFT`（弹簧收敛的尾巴、很慢的拖动）：不算明显变化，
 *   缓存有效时在同一帧按新的几何重新求交，不淡出；停下之后不必等尾巴完全收敛才对上求交的画面。
 *
 * 缓存只覆盖可能落在求交档的范围：两名成员都在“平滑合并范围 + 横向位移”之内的地方，
 * 以及裁剪边切进玻璃的一条。纹素与着色像素对齐，按着色倍率分配；倍率变化后重新求交。
 * 纹素总数有上限（`FIELD_TEXEL_BUDGET`），不够时先释放最久没有出现的组，仍然不够的组不缓存、
 * 静止后每帧逐步求交。连续 `FIELD_IDLE_FRAMES` 帧没有出现的组释放纹理。
 */
export class FieldCache {
  /** 本帧写入缓存的绘制，最多一组。 */
  readonly list = new DrawList()
  /** 本帧是否有组在等待静止、等待写入或正在淡化；为 true 时舞台要继续请求重绘。 */
  settling = false
  /** 全部缓存纹理的纹素总数。 */
  texels = 0
  private readonly gpu: StageGpu
  private readonly frame: FrameEncoder
  private readonly entries: FieldEntry[] = []
  /** 没有缓存纹理的组绑定的 1 × 1 空缓存。 */
  private readonly empty: FieldTextures
  /** 被换下的纹理。本帧已经排好的绘制可能还绑定着它们，下一帧开始时释放。 */
  private readonly retired: GPUTexture[] = []
  /** 本帧写入的范围（纹素：左、上、右、下），见 `prepare()`。 */
  bakeLeft = 0
  bakeTop = 0
  bakeRight = 0
  bakeBottom = 0
  /** 本帧写入缓存的组。 */
  private baking: FieldEntry | null = null
  /** 本帧只写入缓存的一块，其余纹素保留。 */
  private partial = false
  /** 本帧各成员的变化程度。 */
  private readonly changes = new Uint8Array(FIELD_MAX_MEMBERS)
  private readonly scratch = new Float32Array(4)
  private frameId = 0
  private now = 0
  /** 求缓存范围时累计的包围矩形。 */
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

  /** 一帧开始：释放换下的纹理，淘汰久未出现的组。`now` 是当前时间，毫秒。 */
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

  /**
   * 认出这一组并更新它的状态，每帧每组只更新一次（同一组可能画进多个目标）。
   * `data` 里从 `group` 开始是刚写好的体积组 uniform。成员太多或条目用完时返回 null。
   */
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

  /**
   * 在主绘制里调用：几何静止够久之后整组写入；缓存有效时，局部失效的范围静止够久、或小幅漂移的成员附近，
   * 原地重新写入那一块。`ratio` 是绘制目标每个 CSS 像素的像素数。返回 true 时调用方要把求交的绘制加入 `list`，
   * 范围是 `bakeLeft`…`bakeBottom`（纹素）。一帧最多写一组，其余的顺延到下一帧。
   */
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

  /** 这一组读取的折射场：自己的缓存，没有时是空缓存。 */
  texturesOf(entry: FieldEntry): FieldTextures {
    return entry.textures ?? this.empty
  }

  /** 编码本帧的缓存写入，要在读取缓存的各遍之前。 */
  encode(encoder: GPUCommandEncoder): void {
    const entry = this.baking
    if (entry === null || entry.textures === null || this.list.count === 0)
      return
    const target = entry.textures
    this.frame.encodeFieldPass(encoder, target.views, target.width, target.height, this.list, this.partial)
  }

  /**
   * 放弃全部缓存并释放纹理：切换到不使用缓存的光路时调用。
   * 只能在两帧之间调用（上一帧已经提交、这一帧还没有排绘制），之后不会再有 `begin()` 来释放它们。
   */
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

  /**
   * 有成员明显变化：缓存有效、原点成员没有动、受影响的范围不大时只让那一块失效（查表），
   * 否则整组作废。刚写完缓存就又变化时延长等待时间。
   */
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

  /** 小幅漂移的成员附近记进 `refreshRect`，下一次写入时原地更新。 */
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

  /**
   * 变化程度为 `level` 的成员可能改变光路的范围，相对原点成员，写进 `target`：
   * 它写入缓存时与现在的矩形，外扩平滑合并与较厚成员截面延伸的范围、光线的横向位移和交叉淡化的宽度。
   */
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

  /** 整组作废：改用剖面管线，旧结果淡出，静止后整组重新写入。 */
  private invalidate(entry: FieldEntry): void {
    entry.live = false
    entry.stale = false
    entry.dirty = false
    entry.changedAt = this.now
  }

  /** 记下写入缓存时各成员的矩形与时间。 */
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

  /** 销毁换下的纹理。 */
  private flush(): void {
    const retired = this.retired
    for (let i = 0; i < retired.length; i++)
      retired[i]!.destroy()
    retired.length = 0
  }

  /** 记录着同一组成员的条目。 */
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

  /** 为新出现的组取一个条目：空条目，没有时换掉最久没有出现的；本帧都在用时返回 null。 */
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

  /**
   * 求交档可能出现的范围，相对第一名成员的中心，写进 `left`、`top`、`right`、`bottom`。
   *
   * 求交档的像素要么离最近与次近的两名成员都不超过“其余成员不参与平滑合并的距离 + 横向位移”，
   * 要么离所属成员的裁剪边不超过“横向位移 + 半厚度”，要么在圆角比倒角窄的成员的拐角里。
   * 第一种落在两名成员各自外扩之后的交集里，而且有玻璃的像素离最近的成员不超过平滑合并鼓出来的距离
   * （每合并一次最多半个融合距离），所以再与其中一名成员外扩这段距离后的矩形相交；
   * 第二种落在被切进的成员沿裁剪边的一条里；第三种在那名成员的矩形里。
   * 范围之外即使有求交档的像素也只是回到逐步求交。
   */
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
      // 圆角比倒角窄：拐角里那一带的光路要求交（见 glass_corner）。四个拐角的包围矩形通常就是整块玻璃。
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
        // 贴着这名成员、同时在另一名成员附近；再反过来。
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

  /** 把一个矩形并入累计的范围；空矩形不计。 */
  private include(left: number, top: number, right: number, bottom: number): void {
    if (right <= left || bottom <= top)
      return
    this.left = Math.min(this.left, left)
    this.top = Math.min(this.top, top)
    this.right = Math.max(this.right, right)
    this.bottom = Math.max(this.bottom, bottom)
  }

  /**
   * 为 `texels` 个纹素腾出空间：超过上限时释放最久没有出现、本帧也没有用到的组的缓存。
   * 腾不出来时返回 false。
   */
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
      // 它再出现时从查表开始，静止后重新求交。
      this.drop(victim)
      victim.live = false
      victim.stale = false
      victim.dirty = false
      victim.fade = 0
      victim.changedAt = this.now
    }
    return true
  }

  /** 释放一组的缓存纹理：留到下一帧开始时销毁，那时引用它们的帧都已提交。 */
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

  /** 清空一个条目。 */
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
