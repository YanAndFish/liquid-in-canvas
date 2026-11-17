import type { DrawList, FrameEncoder } from '../frame.hot'
import type { PipelineTable, RenderTarget, StageGpu } from '../gpu'
import type { GlassOptics } from '../types'
import type { BackdropBlur } from './blur.hot'
import type { CoverBuilder, CoverRect } from './cover.hot'
import type { FieldEntry } from './field-cache'
import type { FieldCache } from './field-cache.hot'
import type { GlassGroup, NumberSink, VolumeSurface } from './fusion.hot'
import type { ProfileTable } from './optics-lut'
import type { StackGroup, StackLevel } from './stack.hot'
import type { VolumeTextures } from './volume-shader'
import { CLEAR_TRANSPARENT, HEADER_FLOATS } from '../frame'
import { SLOT_CANVAS, SLOT_TARGET } from '../gpu'
import { glassVolumeRenderOrder } from '../render-order'
import { linearTint, srgbToLinear } from './color'
import { bindFieldTextures } from './field-cache'
import { GlassGroups, writePressedBox } from './fusion.hot'
import { createFieldCache, createProfileTable, createStackLevels, createVolumeBands, createVolumePlan, growInt32 } from './pools'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from './profile'
import { assignStackLevels, MAX_STACK_LEVELS, stackMargin } from './stack.hot'
import { HYBRID_CLIP_PAD, hybridLateral } from './volume-hybrid-shader'
import { memberCornered, writeFusionProximity } from './volume-members.hot'
import { bindVolumeTextures, createFieldBakePipelines, createVolumePipelines, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from './volume-shader'

export interface VolumeShading {
  scale: number
  pixelWidth: number
  pixelHeight: number
  cssWidth: number
  cssHeight: number
  split: number
}

export interface VolumeGroupPlan extends StackGroup {
  members: VolumeSurface[]
  count: number
  readonly bounds: CoverRect
  order: number
  layer: number
  variance: number
  margin: number
  ceiling: number
  reach: number
  apart: number
  shadowAlpha: number
  shadowSize: number
}

export interface VolumeBand {
  target: RenderTarget
  list: DrawList
  rects: CoverRect[]
  rectCount: number
  cover: CoverBuilder
}

const NESTED_ORDER_STEP = 0.0001

function materialized(surface: VolumeSurface): number {
  return Math.min(1.3, Math.max(0, surface.materialize))
}

function settled(surface: VolumeSurface): number {
  return Math.min(1, materialized(surface))
}

export function volumeHalfDepth(surface: VolumeSurface): number {
  const source = surface.depthFrom ?? surface
  const base = profileHalfDepth(surface.options.refraction, source.width, source.height)
  return Math.max(0.5, base * materialized(source))
}

function planGroup(plan: VolumeGroupPlan, group: GlassGroup, cssWidth: number, cssHeight: number): void {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let bodyLeft = Infinity
  let bodyTop = Infinity
  let bodyRight = -Infinity
  let bodyBottom = -Infinity
  let highest = 0
  let shadowAlpha = 0
  let shadowSize = 0
  let fusion = 0
  let variance = 0
  let margin = 0
  let paintOrder = -Infinity
  const members = group.members
  for (let i = 0; i < group.count; i++) {
    const member = members[i]!
    const options = member.options
    const halfDepth = volumeHalfDepth(member)
    const amount = settled(member)
    shadowAlpha = Math.max(shadowAlpha, options.shadow * member.opacity * amount)
    shadowSize = Math.max(shadowSize, options.shadowSize)
    fusion = Math.max(fusion, member.fusion)
    variance = Math.max(variance, options.blur * options.blur * amount * amount)
    margin = Math.max(margin, stackMargin(halfDepth, options.elevation))
    paintOrder = Math.max(paintOrder, member.paintOrder)
    const padding = Math.max(member.fusion, options.shadowSize) + 3
    left = Math.min(left, member.left - padding)
    top = Math.min(top, member.top - padding)
    right = Math.max(right, member.left + member.width + padding)
    bottom = Math.max(bottom, member.top + member.height + padding)
    bodyLeft = Math.min(bodyLeft, member.left)
    bodyTop = Math.min(bodyTop, member.top)
    bodyRight = Math.max(bodyRight, member.left + member.width)
    bodyBottom = Math.max(bodyBottom, member.top + member.height)
    highest = Math.max(highest, options.elevation + halfDepth * 2 + member.fusion)
  }
  plan.members = members
  plan.count = group.count
  plan.bounds.left = Math.max(0, left)
  plan.bounds.top = Math.max(0, top)
  plan.bounds.right = Math.min(cssWidth, right)
  plan.bounds.bottom = Math.min(cssHeight, bottom)
  plan.body.left = bodyLeft
  plan.body.top = bodyTop
  plan.body.right = bodyRight
  plan.body.bottom = bodyBottom
  plan.layer = members[0]!.layer
  plan.order = glassVolumeRenderOrder(plan.layer, paintOrder)
  plan.ceiling = highest + 4
  plan.reach = fusion * 2 * (1 + group.count / 4) + 1
  plan.apart = fusion * 2 * (1 + Math.max(0, group.count - 2) / 4) + 1
  plan.shadowAlpha = shadowAlpha
  plan.shadowSize = shadowSize
  plan.variance = variance
  plan.margin = margin
}

export class VolumePlanner {
  readonly plans: VolumeGroupPlan[] = []
  count = 0
  readonly levels: StackLevel[] = createStackLevels()
  private readonly groups = new GlassGroups()
  private sorted = new Int32Array(32)

  build(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number): void {
    const groups = this.groups
    groups.build(surfaces, count)
    for (let i = 0; i < groups.count; i++)
      planGroup(this.plans[i] ?? this.grow(i), groups.groups[i]!, cssWidth, cssHeight)
    this.count = groups.count
    for (let i = 0; i < this.count; i++)
      this.followHost(this.plans[i]!)
    if (this.sorted.length < this.count)
      this.sorted = growInt32(this.count)
    assignStackLevels(this.plans, this.count, this.sorted, this.levels, cssWidth, cssHeight)
  }

  planOf(surface: VolumeSurface): VolumeGroupPlan | null {
    for (let i = 0; i < this.count; i++) {
      const plan = this.plans[i]!
      for (let j = 0; j < plan.count; j++) {
        if (plan.members[j] === surface)
          return plan
      }
    }
    return null
  }

  private followHost(plan: VolumeGroupPlan): void {
    const host = plan.members[0]!.host
    if (host === null)
      return
    for (let i = 0; i < this.count; i++) {
      const other = this.plans[i]!
      for (let j = 0; j < other.count; j++) {
        if (other.members[j]!.id === host) {
          plan.order = Math.max(plan.order, other.order + NESTED_ORDER_STEP)
          return
        }
      }
    }
  }

  private grow(index: number): VolumeGroupPlan {
    const plan = createVolumePlan()
    this.plans[index] = plan
    return plan
  }
}

export function writeVolumeGroup(data: NumberSink, start: number, plan: VolumeGroupPlan, profiles: ProfileTable | null = null): boolean {
  const brightness = srgbToLinear(plan.members[0]!.brightness)
  data[start] = plan.ceiling
  data[start + 1] = plan.reach
  data[start + 2] = brightness
  data[start + 3] = plan.apart
  data[start + 4] = plan.shadowAlpha
  data[start + 5] = plan.shadowSize
  const valid = plan.valid
  data[start + 8] = valid.left
  data[start + 9] = valid.top
  data[start + 10] = valid.right
  data[start + 11] = valid.bottom
  let offset = start + VOLUME_GROUP_FLOATS
  let cut = false
  for (let i = 0; i < plan.count; i++) {
    const member = plan.members[i]!
    const options = member.options
    const tint = linearTint(options.tint)
    const radius = options.radius
    const clip = member.clip
    writePressedBox(data, offset, member)
    data[offset + 4] = radius[0]
    data[offset + 5] = radius[1]
    data[offset + 6] = radius[2]
    data[offset + 7] = radius[3]
    const halfDepth = volumeHalfDepth(member)
    const amount = settled(member)
    const tintAlpha = options.tintAlpha * amount
    data[offset + 8] = halfDepth
    data[offset + 9] = options.elevation
    data[offset + 10] = member.fusion
    data[offset + 11] = Math.min(0.6, options.lens * materialized(member))
    data[offset + 12] = clip[0]!
    data[offset + 13] = clip[1]!
    data[offset + 14] = clip[2]!
    data[offset + 15] = clip[3]!
    data[offset + 16] = options.blur * options.blur * amount * amount
    data[offset + 17] = options.dispersion
    data[offset + 18] = tintAlpha
    data[offset + 19] = options.specular * amount
    data[offset + 20] = tint[0] * brightness * tintAlpha
    data[offset + 21] = tint[1] * brightness * tintAlpha
    data[offset + 22] = tint[2] * brightness * tintAlpha
    data[offset + 23] = member.opacity * Math.min(1, materialized(member) * 3)
    data[offset + 24] = profileBevelWidth(halfDepth, options.bevelWidth)
    data[offset + 25] = profileBevelHeight(halfDepth, options.bevelHeight)
    data[offset + 26] = options.bevelCurve
    data[offset + 27] = options.bottomBevel
    data[offset + 29] = 1 + (options.saturation - 1) * amount
    data[offset + 30] = 1 + (options.brightness - 1) * amount
    data[offset + 32] = options.ior
    if (profiles) {
      const bevelWidth = Math.max(Math.min(data[offset + 24]!, data[offset + 2]!, data[offset + 3]!), 0.5)
      const row = profiles.rowOf(bevelWidth / halfDepth, data[offset + 25]! / halfDepth, options.bevelCurve, options.bottomBevel, options.dispersion, options.ior)
      data[offset + 28] = row
      const pad = hybridLateral(profiles.reachOf(row), halfDepth) + halfDepth + HYBRID_CLIP_PAD
      const x = data[offset]!
      const y = data[offset + 1]!
      const halfWidth = data[offset + 2]!
      const halfHeight = data[offset + 3]!
      cut ||= clip[0]! > x - halfWidth - pad || clip[1]! > y - halfHeight - pad || clip[2]! < x + halfWidth + pad || clip[3]! < y + halfHeight + pad
      cut ||= memberCornered(data, offset)
    }
    offset += VOLUME_MEMBER_FLOATS
  }
  writeFusionProximity(data, start + VOLUME_GROUP_FLOATS, plan.count)
  return cut
}

export class VolumeGroups {
  private readonly gpu: StageGpu
  private readonly frame: FrameEncoder
  private readonly blurs: readonly BackdropBlur[]
  private readonly sources: (GPUTextureView | null)[] = []
  private readonly planner = new VolumePlanner()
  private readonly pipelines: PipelineTable[]
  private readonly profilePipelines: PipelineTable[]
  private readonly hybridPipelines: PipelineTable[]
  private readonly fieldPipelines: PipelineTable[]
  private readonly bakePipelines: PipelineTable
  private profiles: ProfileTable | null = null
  private fields: FieldCache | null = null
  private fieldStore: FieldCache | null = null
  private fieldCache = true
  private optics: GlassOptics = 'raymarch'
  private readonly bands: VolumeBand[]
  private readonly textures = new WeakMap<GPUTextureView, VolumeTextures>()
  private readonly profileTextures = new WeakMap<GPUTextureView, VolumeTextures>()

  constructor(gpu: StageGpu, blurs: readonly BackdropBlur[]) {
    this.gpu = gpu
    this.frame = gpu.frame
    this.blurs = blurs
    for (let i = 0; i < MAX_STACK_LEVELS; i++)
      this.sources.push(null)
    this.pipelines = createVolumePipelines(gpu)
    this.profilePipelines = createVolumePipelines(gpu, 'profile')
    this.hybridPipelines = createVolumePipelines(gpu, 'hybrid')
    this.fieldPipelines = createVolumePipelines(gpu, 'field')
    this.bakePipelines = createFieldBakePipelines(gpu)
    this.bands = createVolumeBands(gpu)
  }

  get groups(): VolumePlanner {
    return this.planner
  }

  get settling(): boolean {
    return this.fields !== null && this.fields.settling
  }

  warm(counts: readonly number[]): void {
    const optics = this.optics
    for (let i = 0; i < counts.length; i++) {
      const count = counts[i]!
      if (optics === 'hybrid' && count === 1) {
        this.profilePipelines[SLOT_CANVAS]!.warm(count)
        this.profilePipelines[SLOT_TARGET]!.warm(count)
      }
      const pipelines = this.table(true)
      pipelines[SLOT_CANVAS]!.warm(count)
      pipelines[SLOT_TARGET]!.warm(count)
      if (optics === 'hybrid' && this.fieldCache) {
        this.profilePipelines[SLOT_CANVAS]!.warm(count)
        this.profilePipelines[SLOT_TARGET]!.warm(count)
        this.fieldPipelines[SLOT_CANVAS]!.warm(count)
        this.fieldPipelines[SLOT_TARGET]!.warm(count)
        this.bakePipelines.warm(count)
      }
    }
  }

  setOptics(optics: GlassOptics): void {
    if (optics === this.optics)
      return
    this.optics = optics
    if (optics !== 'raymarch' && !this.profiles)
      this.profiles = createProfileTable(this.gpu)
    this.selectFields()
  }

  setFieldCache(enabled: boolean): void {
    if (enabled === this.fieldCache)
      return
    this.fieldCache = enabled
    this.selectFields()
  }

  group(surfaces: readonly VolumeSurface[], count: number, cssWidth: number, cssHeight: number, now = performance.now()): void {
    this.profiles?.release()
    this.fields?.begin(now)
    this.planner.build(surfaces, count, cssWidth, cssHeight)
  }

  setSource(level: number, view: GPUTextureView): void {
    this.sources[level] = view
  }

  plan(surfaces: readonly VolumeSurface[], count: number, source: GPUTextureView, shading: VolumeShading, canvas: DrawList, now = performance.now()): void {
    this.group(surfaces, count, shading.cssWidth, shading.cssHeight, now)
    this.setSource(0, source)
    this.draw(shading, canvas)
  }

  draw(shading: VolumeShading, canvas: DrawList): void {
    const bands = this.bands
    bands[0]!.list.reset()
    bands[1]!.list.reset()
    const planner = this.planner
    if (planner.count === 0)
      return
    if (shading.scale >= 1) {
      for (let i = 0; i < planner.count; i++) {
        const bounds = planner.plans[i]!.bounds
        this.push(canvas, SLOT_CANVAS, planner.plans[i]!, bounds.left, bounds.top, bounds.right, bounds.bottom, shading.cssWidth, shading.cssHeight, shading.pixelWidth, shading.pixelHeight, true)
      }
      return
    }

    const width = Math.max(1, Math.ceil(shading.pixelWidth * shading.scale))
    const height = Math.max(1, Math.ceil(shading.pixelHeight * shading.scale))
    const tile = this.gpu.blitScreen.get(SLOT_CANVAS)
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index]!
      band.rectCount = 0
      let order = Infinity
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        const bandIndex = plan.order >= shading.split
          ? 1
          : 0
        if (bandIndex !== index)
          continue
        band.rects[band.rectCount++] = plan.bounds
        order = Math.min(order, plan.order)
      }
      if (band.rectCount === 0)
        continue
      band.target.resize(width, height)
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        if ((plan.order >= shading.split
          ? 1
          : 0) === index) {
          const bounds = plan.bounds
          this.push(band.list, SLOT_TARGET, plan, bounds.left, bounds.top, bounds.right, bounds.bottom, shading.cssWidth, shading.cssHeight, width, height, true)
        }
      }
      const cover = band.cover
      cover.build(band.rects, band.rectCount)
      for (let i = 0; i < cover.count; i++) {
        const rect = cover.rects[i]!
        const start = this.frame.rect(
          HEADER_FLOATS,
          rect.left,
          rect.top,
          rect.right,
          rect.bottom,
          shading.cssWidth,
          shading.cssHeight,
          shading.pixelWidth,
          shading.pixelHeight,
        )
        canvas.push(order, tile, start * 4, band.target.group)
      }
    }
  }

  drawInto(list: DrawList, plan: VolumeGroupPlan, limit: CoverRect, cssWidth: number, cssHeight: number, targetWidth: number, targetHeight: number): void {
    const bounds = plan.bounds
    const left = Math.max(bounds.left, limit.left)
    const top = Math.max(bounds.top, limit.top)
    const right = Math.min(bounds.right, limit.right)
    const bottom = Math.min(bounds.bottom, limit.bottom)
    if (right <= left || bottom <= top)
      return
    this.push(list, SLOT_TARGET, plan, left, top, right, bottom, cssWidth, cssHeight, targetWidth, targetHeight, false)
  }

  encode(encoder: GPUCommandEncoder): void {
    this.fields?.encode(encoder)
    for (let i = 0; i < this.bands.length; i++) {
      const band = this.bands[i]!
      if (band.list.count > 0)
        this.frame.encodePass(encoder, 'band', band.target.view, band.target.width, band.target.height, CLEAR_TRANSPARENT, band.list)
    }
  }

  dispose(): void {
    for (const band of this.bands)
      band.target.dispose()
    this.profiles?.dispose()
    this.fieldStore?.dispose()
    this.fields = null
    this.fieldStore = null
  }

  private selectFields(): void {
    if (this.optics === 'hybrid' && this.fieldCache) {
      this.fieldStore ??= createFieldCache(this.gpu)
      this.fields = this.fieldStore
      return
    }
    this.fields?.reset()
    this.fields = null
  }

  private table(traced: boolean): PipelineTable[] {
    const optics = this.optics
    if (optics === 'raymarch')
      return this.pipelines
    return optics === 'hybrid' && traced
      ? this.hybridPipelines
      : this.profilePipelines
  }

  private push(
    list: DrawList,
    slot: number,
    plan: VolumeGroupPlan,
    left: number,
    top: number,
    right: number,
    bottom: number,
    cssWidth: number,
    cssHeight: number,
    targetWidth: number,
    targetHeight: number,
    primary: boolean,
  ): void {
    const start = this.frame.rect(
      HEADER_FLOATS + VOLUME_GROUP_FLOATS + plan.count * VOLUME_MEMBER_FLOATS,
      left,
      top,
      right,
      bottom,
      cssWidth,
      cssHeight,
      targetWidth,
      targetHeight,
    )
    const profiles = this.optics === 'raymarch'
      ? null
      : this.profiles
    const group = start + HEADER_FLOATS
    const traced = writeVolumeGroup(this.frame.data, group, plan, profiles) || plan.count > 1
    let pipelines = this.table(traced)
    let textures: GPUBindGroup | null = null
    const fields = this.fields
    if (fields !== null && profiles !== null && traced) {
      const entry = fields.track(plan, this.frame.data, group, profiles)
      if (entry !== null) {
        if (primary && fields.prepare(entry, this.frame.data, group, plan.count, profiles, targetWidth / cssWidth))
          this.bake(fields, entry, plan, start, targetWidth, targetHeight, cssWidth, cssHeight)
        if (entry.live || entry.fade > 0) {
          const data = this.frame.data
          data[group + 12] = Math.round((entry.anchorX + entry.originX) * entry.ratio)
          data[group + 13] = Math.round((entry.anchorY + entry.originY) * entry.ratio)
          data[group + 14] = entry.ratio * cssWidth / targetWidth
          data[group + 15] = entry.fade
          pipelines = this.fieldPipelines
          textures = this.fieldGroup(fields, entry, plan.level)
        }
        else {
          pipelines = this.profilePipelines
        }
      }
    }
    list.push(plan.order, pipelines[slot]!.get(plan.count), start * 4, textures ?? this.textureGroup(plan.level))
  }

  private bake(
    fields: FieldCache,
    entry: FieldEntry,
    plan: VolumeGroupPlan,
    source: number,
    targetWidth: number,
    targetHeight: number,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const target = entry.textures!
    const floats = HEADER_FLOATS + VOLUME_GROUP_FLOATS + plan.count * VOLUME_MEMBER_FLOATS
    const start = this.frame.rect(floats, 0, 0, 1, 1, 1, 1, target.width, target.height)
    const data = this.frame.data
    data.copyWithin(start + HEADER_FLOATS, source + HEADER_FLOATS, source + floats)
    data[start + 4] = targetWidth
    data[start + 5] = targetHeight
    data[start + 6] = cssWidth
    data[start + 7] = cssHeight
    const group = start + HEADER_FLOATS
    data[group + 12] = Math.round((entry.anchorX + entry.originX) * entry.ratio)
    data[group + 13] = Math.round((entry.anchorY + entry.originY) * entry.ratio)
    fields.list.push(0, this.bakePipelines.get(plan.count), start * 4, this.textureGroup(plan.level))
  }

  private fieldGroup(fields: FieldCache, entry: FieldEntry, level: number): GPUBindGroup {
    const source = this.sources[level] ?? this.sources[0]!
    const blur = this.blurs[level] ?? this.blurs[0]!
    const profiles = this.profiles!
    const generation = blur.generation * 65536 + profiles.generation
    const bound = entry.bound
    if (bound.source === source && bound.generation === generation && bound.version === entry.version)
      return bound.group
    return bindFieldTextures(this.gpu, entry, source, blur.views, generation, profiles.view, fields.texturesOf(entry))
  }

  private textureGroup(level: number): GPUBindGroup {
    const source = this.sources[level] ?? this.sources[0]!
    const blur = this.blurs[level] ?? this.blurs[0]!
    const profiles = this.optics === 'raymarch'
      ? null
      : this.profiles
    if (profiles) {
      const generation = blur.generation * 65536 + profiles.generation
      const cached = this.profileTextures.get(source)
      if (cached && cached.generation === generation)
        return cached.group
      const bound = bindVolumeTextures(this.gpu, source, blur.views, generation, profiles.view)
      this.profileTextures.set(source, bound)
      return bound.group
    }
    const cached = this.textures.get(source)
    if (cached && cached.generation === blur.generation)
      return cached.group
    const bound = bindVolumeTextures(this.gpu, source, blur.views, blur.generation)
    this.textures.set(source, bound)
    return bound.group
  }
}
