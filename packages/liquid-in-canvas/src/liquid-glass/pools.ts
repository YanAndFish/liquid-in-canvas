import type { StageGpu } from '../gpu'
import type { StackRecord } from './content-order.hot'
import type { CoverRect } from './cover.hot'
import type { GlassGroup } from './fusion.hot'
import type { StackLevel } from './stack.hot'
import type { VolumeBand, VolumeGroupPlan } from './VolumeGroups.hot'
import { DrawList } from '../frame.hot'
import { RenderTarget } from '../gpu'
import { CoverBuilder } from './cover.hot'
import { FieldCache } from './field-cache.hot'
import { ProfileTable } from './optics-lut'
import { MAX_STACK_LEVELS } from './stack.hot'

export function createGroup(): GlassGroup {
  return {
    members: [],
    count: 0,
  }
}

export function createCoverRect(): CoverRect {
  return {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  }
}

export function createVolumePlan(): VolumeGroupPlan {
  return {
    members: [],
    count: 0,
    bounds: createCoverRect(),
    body: createCoverRect(),
    valid: createCoverRect(),
    order: 0,
    layer: 0,
    variance: 0,
    margin: 0,
    level: 0,
    viewerOrders: Array.from<number>({ length: MAX_STACK_LEVELS }).fill(Infinity),
    contentSeen: Array.from<boolean>({ length: MAX_STACK_LEVELS }).fill(false),
    seenRegions: Array.from({ length: MAX_STACK_LEVELS }, createCoverRect),
    contentRegions: Array.from({ length: MAX_STACK_LEVELS }, createCoverRect),
    ceiling: 0,
    reach: 0,
    apart: 0,
    shadowAlpha: 0,
    shadowSize: 0,
  }
}

export function createStackLevels(): StackLevel[] {
  return Array.from({ length: MAX_STACK_LEVELS }, (_, index) => ({
    used: index === 0,
    region: createCoverRect(),
    variance: 0,
  }))
}

export function createVolumeBands(gpu: StageGpu): VolumeBand[] {
  return [0, 1].map(() => ({
    target: new RenderTarget(gpu),
    list: new DrawList(),
    rects: [],
    rectCount: 0,
    cover: new CoverBuilder(),
  }))
}

export function createStackRecord(): StackRecord {
  return {
    frame: -1,
    context: false,
    level: 0,
  }
}

export function growUint8(count: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Math.max(32, count * 2))
}

export function growFloat64(count: number): Float64Array<ArrayBuffer> {
  return new Float64Array(Math.max(32, count * 2))
}

export function growInt32(count: number): Int32Array<ArrayBuffer> {
  return new Int32Array(Math.max(32, count * 2))
}

export function createProfileTable(gpu: StageGpu): ProfileTable {
  return new ProfileTable(gpu)
}

export function createFieldCache(gpu: StageGpu): FieldCache {
  return new FieldCache(gpu)
}
