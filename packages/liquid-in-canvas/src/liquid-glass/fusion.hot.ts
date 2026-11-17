import type { GlassOptions } from './options'
import { createGroup, growUint8 } from './pools'

export interface VolumeSurface {
  id: number
  left: number
  top: number
  width: number
  height: number
  layer: number
  options: GlassOptions
  fusion: number
  clip: number[]
  opacity: number
  brightness: number
  paintOrder: number
  press: number
  materialize: number
  host: number | null
  depthFrom?: VolumeSurface
}

export interface GlassGroup {
  readonly members: VolumeSurface[]
  count: number
}

export interface NumberSink {
  [index: number]: number
}

export function surfaceGap(a: VolumeSurface, b: VolumeSurface): number {
  return Math.hypot(
    Math.max(a.left - b.left - b.width, b.left - a.left - a.width, 0),
    Math.max(a.top - b.top - b.height, b.top - a.top - a.height, 0),
  )
}

function fusable(a: VolumeSurface, b: VolumeSurface): boolean {
  if (a.layer !== b.layer || a.host !== b.host)
    return false
  const reach = Math.min(a.fusion, b.fusion)
  return reach > 0 && surfaceGap(a, b) <= reach
}

export const MATERIALIZE_SCALE = 0.08

export function surfaceScale(surface: VolumeSurface): number {
  return 1 - MATERIALIZE_SCALE + MATERIALIZE_SCALE * surface.materialize
}

export function writePressedBox(target: NumberSink, offset: number, surface: VolumeSurface): void {
  const scale = surfaceScale(surface)
  target[offset] = surface.left + surface.width / 2
  target[offset + 1] = surface.top + surface.height / 2
  target[offset + 2] = surface.width / 2 * (1 + surface.press * 0.018) * scale
  target[offset + 3] = surface.height / 2 * (1 - surface.press * 0.025) * scale
}

export class GlassGroups {
  readonly groups: GlassGroup[] = []
  count = 0
  private taken = new Uint8Array(32)

  build(surfaces: readonly VolumeSurface[], count: number): void {
    if (this.taken.length < count)
      this.taken = growUint8(count)
    const taken = this.taken
    taken.fill(0, 0, count)
    this.count = 0
    for (let first = 0; first < count; first++) {
      if (taken[first])
        continue
      taken[first] = 1
      const group = this.groups[this.count] ?? this.grow()
      this.count++
      const members = group.members
      members[0] = surfaces[first]!
      group.count = 1
      for (let index = 0; index < group.count; index++) {
        const current = members[index]!
        for (let candidate = first + 1; candidate < count; candidate++) {
          if (taken[candidate] || !fusable(current, surfaces[candidate]!))
            continue
          taken[candidate] = 1
          members[group.count++] = surfaces[candidate]!
        }
      }
      sortById(members, group.count)
    }
  }

  private grow(): GlassGroup {
    const group = createGroup()
    this.groups[this.count] = group
    return group
  }
}

function sortById(members: VolumeSurface[], count: number): void {
  for (let i = 1; i < count; i++) {
    const item = members[i]!
    let j = i - 1
    while (j >= 0 && members[j]!.id > item.id) {
      members[j + 1] = members[j]!
      j--
    }
    members[j + 1] = item
  }
}
