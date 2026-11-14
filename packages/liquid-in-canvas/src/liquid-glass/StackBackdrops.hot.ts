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

/** 没有遮挡轮廓：下层玻璃的内容完整画进背景，被更上层的玻璃盖住由绘制顺序决定。 */
const NO_OCCLUDERS: readonly never[] = []

/** 一级背景（第 1 级起）的离屏目标、绘制列表与模糊。 */
interface StackTarget {
  readonly target: RenderTarget
  readonly list: DrawList
  readonly blur: BackdropBlur
}

/**
 * 第 1 级起的背景：页面背景加上这一级玻璃看到的下层玻璃与它们的 HTML 内容，再单独模糊。
 *
 * 每一级背景都是 CSS 分辨率的离屏目标，只在这一级的取样范围（加上模糊需要的余量）里复制页面背景、
 * 绘制下层玻璃。同一级被多组共用，每块下层玻璃与它的内容只画进看到它的那些组的取样范围，
 * 否则远处一块面板看到的文字会出现在同级另一块玻璃（比如标签栏的激活项）的折射里。下层玻璃仍取样各自那一级的背景，所以按级别从低到高编码。
 * 取样范围之外清成黑色，体积着色器把取样坐标夹在范围之内。
 */
export class StackBackdrops {
  private readonly frame: FrameEncoder
  private readonly copy: PipelineTable
  private readonly stacked: PipelineTable
  /** 下标是背景级别；第 0 级是页面背景，不在这里，留空。 */
  private readonly levels: (StackTarget | null)[] = []
  private readonly active: boolean[] = []

  /** `blurs` 的下标是背景级别，第 0 级的不使用；`stacked` 是下层玻璃内容的管线表。 */
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

  /**
   * 安排第 1 级起的背景。`volumes` 已经分组并分好级别；`base` 是第 0 级背景；
   * `contents` 的前 `contentCount` 项是本帧可见的玻璃，`plans` 是它们各自所在的组，
   * `contentOrders` 是它们的内容在画布遍中的绘制顺序，背景里沿用同样的先后。
   */
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
      // 复制页面背景：模糊要读取取样范围外一圈的内容。
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
        // 只画进看到这块内容的组的取样范围：同级其他组（比如嵌套在这块玻璃里的激活项）不该看到它。
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

  /** 按级别从低到高编码：每一级先画背景，再模糊。 */
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
