import type { FrameEncoder } from '../frame.hot'
import type { PipelineTable, StageGpu } from '../gpu'
import type { BackdropBlur } from './blur.hot'
import type { ContentSource } from './content.hot'
import type { BackdropSource } from './ContentBackdrop.hot'
import type { VolumeGroupPlan, VolumeGroups } from './VolumeGroups.hot'
import { CLEAR_BLACK, HEADER_FLOATS } from '../frame'
import { DrawList } from '../frame.hot'
import { RenderTarget, SLOT_TARGET } from '../gpu'
import { blurReach } from './blur.hot'
import { writeContent } from './content.hot'
import { MAX_STACK_LEVELS } from './stack.hot'
import { REFLECTION_VARIANCE } from './volume-shader'

const NO_OCCLUDERS: readonly never[] = []

interface StackTarget {
  readonly target: RenderTarget
  readonly list: DrawList
  readonly blur: BackdropBlur
}

export class StackBackdrops {
  private readonly frame: FrameEncoder
  private readonly copy: PipelineTable
  private readonly stacked: PipelineTable
  private readonly levels: (StackTarget | null)[] = []
  private readonly active: boolean[] = []

  constructor(gpu: StageGpu, blurs: readonly BackdropBlur[], stacked: PipelineTable) {
    this.frame = gpu.frame
    this.copy = gpu.blitScreenOpaque
    this.stacked = stacked
    for (let level = 0; level < MAX_STACK_LEVELS; level++) {
      this.active.push(false)
      this.levels.push(level === 0
        ? null
        : {
            target: new RenderTarget(gpu),
            list: new DrawList(),
            blur: blurs[level]!,
          })
    }
  }

  plan(
    volumes: VolumeGroups,
    base: BackdropSource,
    contents: readonly ContentSource[],
    plans: readonly (VolumeGroupPlan | null)[],
    contentOrders: Float64Array,
    contentCount: number,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const planner = volumes.groups
    const width = Math.max(1, Math.ceil(cssWidth))
    const height = Math.max(1, Math.ceil(cssHeight))
    const frame = this.frame
    for (let level = 1; level < MAX_STACK_LEVELS; level++) {
      const stack = this.levels[level]!
      stack.list.reset()
      const info = planner.levels[level]!
      this.active[level] = info.used
      if (!info.used) {
        stack.blur.plan(base.group, 0, 0, 0)
        continue
      }
      const variance = info.variance + REFLECTION_VARIANCE
      const region = info.region
      const reach = blurReach(variance)
      stack.target.resize(width, height)
      volumes.setSource(level, stack.target.view)
      const copy = frame.rect(
        HEADER_FLOATS,
        Math.max(0, region.left - reach),
        Math.max(0, region.top - reach),
        Math.min(cssWidth, region.right + reach),
        Math.min(cssHeight, region.bottom + reach),
        cssWidth,
        cssHeight,
        width,
        height,
      )
      stack.list.push(-Infinity, this.copy.get(SLOT_TARGET), copy * 4, base.group)
      for (let i = 0; i < planner.count; i++) {
        const plan = planner.plans[i]!
        if (plan.level < level && plan.viewerOrders[level]! < Infinity)
          volumes.drawInto(stack.list, plan, plan.seenRegions[level]!, cssWidth, cssHeight, width, height)
      }
      for (let i = 0; i < contentCount; i++) {
        const plan = plans[i]
        const source = contents[i]!
        if (!plan || !source.content || plan.level >= level || !plan.contentSeen[level])
          continue
        const uniform = writeContent(frame, source, NO_OCCLUDERS, 0, cssWidth, cssHeight, width, height)
        const limit = plan.contentRegions[level]!
        const clip = uniform / 4 + HEADER_FLOATS
        const data = frame.data
        data[clip] = Math.max(data[clip]!, limit.left)
        data[clip + 1] = Math.max(data[clip + 1]!, limit.top)
        data[clip + 2] = Math.min(data[clip + 2]!, limit.right)
        data[clip + 3] = Math.min(data[clip + 3]!, limit.bottom)
        stack.list.push(contentOrders[i]!, this.stacked.get(0), uniform, source.content.group)
      }
      stack.blur.plan(stack.target.group, cssWidth, cssHeight, variance, region)
    }
  }

  encode(encoder: GPUCommandEncoder): void {
    for (let level = 1; level < MAX_STACK_LEVELS; level++) {
      if (!this.active[level])
        continue
      const stack = this.levels[level]!
      this.frame.encodePass(encoder, 'stack', stack.target.view, stack.target.width, stack.target.height, CLEAR_BLACK, stack.list)
      stack.blur.encode(encoder)
    }
  }

  dispose(): void {
    for (let level = 1; level < MAX_STACK_LEVELS; level++)
      this.levels[level]!.target.dispose()
  }
}
