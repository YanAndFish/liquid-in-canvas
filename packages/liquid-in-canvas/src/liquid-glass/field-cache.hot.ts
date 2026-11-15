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
  FIELD_ENTRIES,
  FIELD_FADE_IN_MS,
  FIELD_FADE_OUT_MS,
  FIELD_FADE_STEP_MS,
  FIELD_IDLE_FRAMES,
  FIELD_MAX_MEMBERS,
  FIELD_SETTLE_MS,
  FIELD_SIZE_STEP,
  FIELD_TEXEL_BUDGET,
  FIELD_TOLERANCE,
} from './field-cache'
import { HYBRID_CLIP_PAD, hybridLateral } from './volume-hybrid-shader'
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

/** 写入一项几何特征，返回它是否超出容差地变了。没有写过的位置是 NaN，一定算变化。 */
function put(signature: Float32Array, index: number, value: number): boolean {
  if (Math.abs(signature[index]! - value) <= FIELD_TOLERANCE)
    return false
  signature[index] = value
  return true
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
 * - 有变化（成员相对运动、尺寸、圆角、厚度、截面、按压与材质化、裁剪切进玻璃的位置、色散）：
 *   缓存作废，这一组改用剖面管线查表，上一次的求交结果在 `FIELD_FADE_OUT_MS` 里淡出。
 * - 保持不变满 `FIELD_SETTLE_MS`：`prepare()` 安排求交一次、写进缓存，之后用读缓存的管线，
 *   求交结果在 `FIELD_FADE_IN_MS` 里淡入。整组平移（随页面滚动）不改变特征，缓存一直有效。
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
  /** 本帧写入缓存的组。 */
  private baking: FieldEntry | null = null
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
    const retired = this.retired
    for (let i = 0; i < retired.length; i++)
      retired[i]!.destroy()
    retired.length = 0
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
    const anchorX = data[members]!
    const anchorY = data[members + 1]!
    entry.anchorX = anchorX
    entry.anchorY = anchorY
    const signature = entry.signature
    let changed = false
    let s = 0
    for (let i = 0; i < count; i++) {
      const m = members + i * VOLUME_MEMBER_FLOATS
      const x = data[m]!
      const y = data[m + 1]!
      const halfWidth = data[m + 2]!
      const halfHeight = data[m + 3]!
      const halfDepth = data[m + 8]!
      changed = put(signature, s++, x - anchorX) || changed
      changed = put(signature, s++, y - anchorY) || changed
      changed = put(signature, s++, halfWidth) || changed
      changed = put(signature, s++, halfHeight) || changed
      // 圆角、半厚度、底面高度、融合距离。
      for (let k = 4; k < 11; k++)
        changed = put(signature, s++, data[m + k]!) || changed
      // 裁剪边离玻璃足够远时不改变距离场（与 `writeVolumeGroup` 判断裁剪是否切进玻璃的条件相同），
      // 记成固定的远处：玻璃在裁剪容器里滚动时缓存仍然有效。
      const pad = hybridLateral(profiles.reachOf(data[m + 28]!), halfDepth) + halfDepth + HYBRID_CLIP_PAD
      const clipLeft = data[m + 12]!
      const clipTop = data[m + 13]!
      const clipRight = data[m + 14]!
      const clipBottom = data[m + 15]!
      changed = put(signature, s++, edge(clipLeft > x - halfWidth - pad, clipLeft - anchorX, -FIELD_CLIP_FAR)) || changed
      changed = put(signature, s++, edge(clipTop > y - halfHeight - pad, clipTop - anchorY, -FIELD_CLIP_FAR)) || changed
      changed = put(signature, s++, edge(clipRight < x + halfWidth + pad, clipRight - anchorX, FIELD_CLIP_FAR)) || changed
      changed = put(signature, s++, edge(clipBottom < y + halfHeight + pad, clipBottom - anchorY, FIELD_CLIP_FAR)) || changed
      // 色散决定红蓝两条光路。
      changed = put(signature, s++, data[m + 17]!) || changed
      // 倒角的宽度与高度、曲线指数、底面倒角。
      for (let k = 24; k < 28; k++)
        changed = put(signature, s++, data[m + k]!) || changed
    }
    if (changed) {
      entry.live = false
      entry.changedAt = this.now
    }
    const step = Math.min(Math.max(this.now - entry.seenAt, 0), FIELD_FADE_STEP_MS)
    entry.seenAt = this.now
    const fade = entry.live
      ? entry.fade + step / FIELD_FADE_IN_MS
      : entry.fade - step / FIELD_FADE_OUT_MS
    // 留一点余量：逐帧累加的舍入误差不该让淡化多拖一帧。
    entry.fade = fade > 0.999
      ? 1
      : fade < 0.001
        ? 0
        : fade
    if (!entry.live || entry.fade < 1)
      this.settling = true
    return entry
  }

  /**
   * 在主绘制里调用：几何静止够久、上一次的结果已经淡出之后，为这一组准备缓存。
   * `ratio` 是绘制目标每个 CSS 像素的像素数。返回 true 时调用方要把求交的绘制加入 `list`；
   * 一帧最多写一组，其余的顺延到下一帧。
   */
  prepare(entry: FieldEntry, data: Float32Array, group: number, count: number, profiles: ReachSource, ratio: number): boolean {
    if (entry.live) {
      // 着色倍率变了（自适应降级、分辨率设置）：纹素不再与像素对齐，重新求交。
      if (entry.textures !== null && Math.abs(entry.ratio - ratio) > 1e-4) {
        entry.live = false
        entry.changedAt = this.now
        this.settling = true
      }
      return false
    }
    if (entry.fade > 0 || this.now - entry.changedAt < FIELD_SETTLE_MS || this.baking !== null)
      return false
    entry.live = true
    this.measure(data, group, count, profiles)
    if (this.right <= this.left || this.bottom <= this.top) {
      // 没有需要求交的范围。
      this.drop(entry)
      return false
    }
    // 缓存的左上角落在着色像素的边界上，纹素中心与像素中心重合；外圈留一个像素。
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
    this.frame.encodeFieldPass(encoder, target.views, target.width, target.height, this.list)
  }

  /** 放弃全部缓存：切换到不使用缓存的光路时调用。纹理在下一帧开始时释放。 */
  reset(): void {
    const entries = this.entries
    for (let i = 0; i < entries.length; i++)
      this.forget(entries[i]!)
    this.baking = null
    this.list.reset()
    this.settling = false
  }

  dispose(): void {
    this.reset()
    const retired = this.retired
    for (let i = 0; i < retired.length; i++)
      retired[i]!.destroy()
    retired.length = 0
    const empty = this.empty.textures
    for (let i = 0; i < empty.length; i++)
      empty[i]!.destroy()
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
    chosen.frame = -1
    chosen.seenAt = this.now
    chosen.changedAt = this.now
    return chosen
  }

  /**
   * 求交档可能出现的范围，相对第一名成员的中心，写进 `left`、`top`、`right`、`bottom`。
   *
   * 求交档的像素要么离最近与次近的两名成员都不超过“其余成员不参与平滑合并的距离 + 横向位移”，
   * 要么离所属成员的裁剪边不超过“横向位移 + 半厚度”。前者落在两名成员各自外扩之后的交集里，
   * 而且有玻璃的像素离最近的成员不超过平滑合并鼓出来的距离（每合并一次最多半个融合距离），
   * 所以再与其中一名成员外扩这段距离后的矩形相交；后者落在被切进的成员沿裁剪边的一条里。
   * 范围之外即使有求交档的像素也只是回到逐步求交。
   */
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
    entry.fade = 0
  }
}
