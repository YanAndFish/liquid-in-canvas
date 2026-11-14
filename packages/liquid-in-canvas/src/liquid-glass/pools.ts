import type { PipelineTable, StageGpu } from '../gpu'
/**
 * 热路径对象池的冷路径：创建池里的对象、扩容类型化数组。
 *
 * 只在池第一次需要更多对象时调用，例如可见玻璃的数量第一次超过以往的最大值。
 */
import type { StackRecord } from './content-order.hot'
import type { CoverRect } from './cover.hot'
import type { GlassGroup } from './fusion.hot'
import type { StackLevel } from './stack.hot'
import type { VolumeBand, VolumeGroupPlan } from './VolumeGroups.hot'
import { DrawList } from '../frame.hot'
import { RenderTarget } from '../gpu'
import { CoverBuilder } from './cover.hot'
import { ProfileTable } from './optics-lut'
import { MAX_STACK_LEVELS } from './stack.hot'
import { createVolumePipelines } from './volume-shader'

/** 创建一个空的玻璃分组。 */
export function createGroup(): GlassGroup {
  return {
    members: [],
    count: 0,
  }
}

/** 创建一个覆盖矩形。 */
export function createCoverRect(): CoverRect {
  return {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  }
}

/** 创建一组体积的规划对象。 */
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
    shadowAlpha: 0,
    shadowSize: 0,
  }
}

/** 创建各级背景的范围记录。 */
export function createStackLevels(): StackLevel[] {
  return Array.from({ length: MAX_STACK_LEVELS }, (_, index) => ({
    used: index === 0,
    region: createCoverRect(),
    variance: 0,
  }))
}

/** 低分辨率体积的两段离屏目标：前景层之下与之上。 */
export function createVolumeBands(gpu: StageGpu): VolumeBand[] {
  return [0, 1].map(() => ({
    target: new RenderTarget(gpu),
    list: new DrawList(),
    rects: [],
    rectCount: 0,
    cover: new CoverBuilder(),
  }))
}

/** 创建一个层叠上下文记录，第一次比较某个元素时调用。 */
export function createStackRecord(): StackRecord {
  return {
    frame: -1,
    context: false,
    level: 0,
  }
}

/** 扩容到至少 `count` 项，原有内容不保留。 */
export function growUint8(count: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Math.max(32, count * 2))
}

/** 扩容到至少 `count` 项，原有内容不保留。 */
export function growFloat64(count: number): Float64Array<ArrayBuffer> {
  return new Float64Array(Math.max(32, count * 2))
}

/** 扩容到至少 `count` 项，原有内容不保留。 */
export function growInt32(count: number): Int32Array<ArrayBuffer> {
  return new Int32Array(Math.max(32, count * 2))
}

/** 剖面光学的管线与查找表，第一次切换到剖面光学时创建。 */
export function createProfileTable(gpu: StageGpu): { pipelines: PipelineTable[], table: ProfileTable } {
  return {
    pipelines: createVolumePipelines(gpu, true),
    table: new ProfileTable(gpu),
  }
}
