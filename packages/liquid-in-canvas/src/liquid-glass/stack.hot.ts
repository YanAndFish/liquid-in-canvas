import type { CoverRect } from './cover.hot'

/**
 * 多层玻璃的背景分级。
 *
 * 上层玻璃要折射、模糊它下面的玻璃，就需要一张已经画好下层玻璃的背景。每一级背景是
 * “页面背景 + 被这一级玻璃看到的低级玻璃（体积与 HTML 内容）”，再单独做一套模糊。
 * 不和任何下层玻璃交叠的组留在第 0 级，直接取样页面背景，常见情况不增加开销。
 *
 * 级数有上限，超过上限的组与最高一级共用背景，看不到同级的其他玻璃。
 */

/** 背景级数的上限，第 0 级是页面背景。 */
export const MAX_STACK_LEVELS = 3

/** 取样坐标在离屏纹理边缘留出的余量，与体积着色器原来的夹取范围一致。 */
export const STACK_UV_EDGE = 0.001

/** 分组成员中分级需要的字段。 */
export interface StackMember {
  readonly id: number
  /** 嵌套玻璃所在外层玻璃的编号。 */
  readonly host: number | null
}

/** 参与分级的一组玻璃。由 `VolumeGroupPlan` 实现。 */
export interface StackGroup {
  /** 成员，前 `count` 项有效。 */
  readonly members: readonly StackMember[]
  readonly count: number
  /** 绘制顺序。 */
  readonly order: number
  /** 玻璃层级。 */
  readonly layer: number
  /** 含阴影与融合余量的绘制范围，已裁剪到视口之内。 */
  readonly bounds: CoverRect
  /** 成员玻璃本身的包围矩形，不含余量。 */
  readonly body: CoverRect
  /** 折射与反射取样可能到达的、轮廓之外的距离。 */
  readonly margin: number
  /** 成员中最大的模糊方差。 */
  readonly variance: number
  /** 分到的背景级别。 */
  level: number
  /** 第 k 级背景里，看到这一组的各组中最小的绘制顺序；没有被看到时为 Infinity。 */
  readonly viewerOrders: number[]
  /**
   * 第 k 级背景是否要画这一组的 HTML 内容。嵌套玻璃看得到外层的体积，
   * 但外层的文字画在嵌套玻璃之上，只被嵌套玻璃看到时不画。
   */
  readonly contentSeen: boolean[]
  /**
   * 第 k 级背景里，看到这一组体积的各组取样范围之并的包围矩形（CSS 像素）。
   * 同一级背景被多组共用，下层玻璃只画进看到它的组的取样范围，不会出现在同级其他组的取样里。
   */
  readonly seenRegions: CoverRect[]
  /** 同上，只算看到这一组 HTML 内容的组。 */
  readonly contentRegions: CoverRect[]
  /** 取样坐标的有效范围（归一化）：左、上、右、下。 */
  readonly valid: CoverRect
}

/** 一级背景本帧的范围与模糊需求。 */
export interface StackLevel {
  /** 本帧是否有组使用这一级。第 0 级总是使用。 */
  used: boolean
  /** 这一级各组的取样范围之并的包围矩形，CSS 像素，已裁剪到视口。 */
  readonly region: CoverRect
  /** 这一级各组成员中最大的模糊方差。 */
  variance: number
}

function emptyRect(rect: CoverRect): void {
  rect.left = Infinity
  rect.top = Infinity
  rect.right = -Infinity
  rect.bottom = -Infinity
}

/** 把 `group` 的取样范围（本体加余量）并入 `rect`。 */
function includeSampling(rect: CoverRect, group: StackGroup): void {
  const body = group.body
  const margin = group.margin
  rect.left = Math.min(rect.left, body.left - margin)
  rect.top = Math.min(rect.top, body.top - margin)
  rect.right = Math.max(rect.right, body.right + margin)
  rect.bottom = Math.max(rect.bottom, body.bottom + margin)
}

function intersectsExpanded(a: CoverRect, b: CoverRect, margin: number): boolean {
  return a.right > b.left - margin
    && a.left < b.right + margin
    && a.bottom > b.top - margin
    && a.top < b.bottom + margin
}

/**
 * `above` 是否需要在背景里看到 `below`。
 *
 * 只有先画的组才可能被看到，而且 `below` 的绘制范围要落进 `above` 的取样范围。
 * 不同层级之间按此判断；同一层级的两组只有本体相互重叠时才算（嵌套玻璃与外层、
 * 关闭融合后重叠的同层玻璃），否则同层相邻的控件会因为阴影接近而层层分级。
 */
export function stackSees(below: StackGroup, above: StackGroup): boolean {
  if (below.order >= above.order)
    return false
  if (!intersectsExpanded(below.bounds, above.body, above.margin))
    return false
  if (below.layer !== above.layer)
    return true
  return intersectsExpanded(below.body, above.body, 0)
}

/** `inner` 的第一个成员是否嵌套在 `outer` 的某个成员里。 */
function nestedIn(inner: StackGroup, outer: StackGroup): boolean {
  const host = inner.members[0]!.host
  if (host === null)
    return false
  for (let i = 0; i < outer.count; i++) {
    if (outer.members[i]!.id === host)
      return true
  }
  return false
}

/**
 * 为前 `count` 组分配背景级别，并算出每级的范围与模糊需求。
 *
 * `sorted` 是可写的下标数组，长度不小于 `count`，用于按绘制顺序遍历。
 * 级别取所有看到的组的级别加一，超过上限时截到最高一级。截断后与自己同级的组不算被看到。
 */
export function assignStackLevels(
  groups: readonly StackGroup[],
  count: number,
  sorted: Int32Array,
  levels: readonly StackLevel[],
  cssWidth: number,
  cssHeight: number,
): void {
  for (let i = 0; i < count; i++) {
    sorted[i] = i
    const group = groups[i]!
    group.level = 0
    const viewers = group.viewerOrders
    const content = group.contentSeen
    for (let k = 0; k < MAX_STACK_LEVELS; k++) {
      viewers[k] = Infinity
      content[k] = false
      emptyRect(group.seenRegions[k]!)
      emptyRect(group.contentRegions[k]!)
    }
  }
  // 按绘制顺序插入排序。
  for (let i = 1; i < count; i++) {
    const index = sorted[i]!
    const order = groups[index]!.order
    let j = i - 1
    while (j >= 0 && groups[sorted[j]!]!.order > order) {
      sorted[j + 1] = sorted[j]!
      j--
    }
    sorted[j + 1] = index
  }
  for (let k = 0; k < MAX_STACK_LEVELS; k++) {
    const level = levels[k]!
    level.used = k === 0
    level.variance = 0
    emptyRect(level.region)
  }

  for (let i = 0; i < count; i++) {
    const above = groups[sorted[i]!]!
    let level = 0
    for (let j = 0; j < i; j++) {
      const below = groups[sorted[j]!]!
      if (stackSees(below, above))
        level = Math.max(level, below.level + 1)
    }
    above.level = Math.min(level, MAX_STACK_LEVELS - 1)
    if (above.level === 0)
      continue
    for (let j = 0; j < i; j++) {
      const below = groups[sorted[j]!]!
      if (below.level < above.level && stackSees(below, above)) {
        below.viewerOrders[above.level] = Math.min(below.viewerOrders[above.level]!, above.order)
        includeSampling(below.seenRegions[above.level]!, above)
        if (!nestedIn(above, below)) {
          below.contentSeen[above.level] = true
          includeSampling(below.contentRegions[above.level]!, above)
        }
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const group = groups[i]!
    const level = levels[group.level]!
    level.used = true
    level.variance = Math.max(level.variance, group.variance)
    if (group.level !== 0)
      includeSampling(level.region, group)
  }
  const level0 = levels[0]!.region
  level0.left = 0
  level0.top = 0
  level0.right = cssWidth
  level0.bottom = cssHeight
  for (let k = 1; k < MAX_STACK_LEVELS; k++) {
    const region = levels[k]!.region
    if (!levels[k]!.used) {
      region.left = 0
      region.top = 0
      region.right = 0
      region.bottom = 0
      continue
    }
    region.left = Math.max(0, region.left)
    region.top = Math.max(0, region.top)
    region.right = Math.min(cssWidth, region.right)
    region.bottom = Math.min(cssHeight, region.bottom)
  }

  for (let i = 0; i < count; i++) {
    const group = groups[i]!
    const region = levels[group.level]!.region
    const valid = group.valid
    valid.left = Math.max(STACK_UV_EDGE, region.left / cssWidth)
    valid.top = Math.max(STACK_UV_EDGE, region.top / cssHeight)
    valid.right = Math.min(1 - STACK_UV_EDGE, region.right / cssWidth)
    valid.bottom = Math.min(1 - STACK_UV_EDGE, region.bottom / cssHeight)
  }
}

/** 一块成员玻璃的取样余量：倒角折射、底面高度下的出射偏移与屏幕空间反射。 */
export function stackMargin(halfDepth: number, elevation: number): number {
  return halfDepth * 2 + elevation * 3 + 48
}
