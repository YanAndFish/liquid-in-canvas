import type { CoverRect } from './cover.hot'

export const MAX_STACK_LEVELS = 3

export const STACK_UV_EDGE = 0.001

export interface StackMember {
  readonly id: number
  readonly host: number | null
}

export interface StackGroup {
  readonly members: readonly StackMember[]
  readonly count: number
  readonly order: number
  readonly layer: number
  readonly bounds: CoverRect
  readonly body: CoverRect
  readonly margin: number
  readonly variance: number
  level: number
  readonly viewerOrders: number[]
  readonly contentSeen: boolean[]
  readonly seenRegions: CoverRect[]
  readonly contentRegions: CoverRect[]
  readonly valid: CoverRect
}

export interface StackLevel {
  used: boolean
  readonly region: CoverRect
  variance: number
}

function emptyRect(rect: CoverRect): void {
  rect.left = Infinity
  rect.top = Infinity
  rect.right = -Infinity
  rect.bottom = -Infinity
}

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

export function stackSees(below: StackGroup, above: StackGroup): boolean {
  if (below.order >= above.order)
    return false
  if (!intersectsExpanded(below.bounds, above.body, above.margin))
    return false
  if (below.layer !== above.layer)
    return true
  return intersectsExpanded(below.body, above.body, 0)
}

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

export function stackMargin(halfDepth: number, elevation: number): number {
  return halfDepth * 2 + elevation * 3 + 48
}
