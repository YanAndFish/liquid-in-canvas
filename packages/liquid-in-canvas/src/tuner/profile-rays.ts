import { BASE_IOR } from '../liquid-glass/profile'

export interface ProfileRay {
  points: [number, number][]
  landing: number | null
}

const EPSILON = 1e-4
const MAX_EVENTS = 6

export function traceProfileRays(outline: readonly [number, number][], starts: readonly number[], height: number, ior = BASE_IOR): ProfileRay[] {
  return starts.map(x => traceRay(outline, x, height, ior))
}

function traceRay(outline: readonly [number, number][], startX: number, height: number, ior: number): ProfileRay {
  const points: [number, number][] = [
    [startX, height],
  ]
  let px = startX
  let pz = height
  let dx = 0
  let dz = -1
  let inside = false
  let bounced = false
  const count = outline.length
  for (let event = 0; event < MAX_EVENTS; event++) {
    let nearest = Infinity
    let segment = -1
    for (let i = 0; i < count; i++) {
      const [ax, az] = outline[i]!
      const [bx, bz] = outline[(i + 1) % count]!
      const t = intersect(px, pz, dx, dz, ax, az, bx, bz)
      if (t !== null && t < nearest) {
        nearest = t
        segment = i
      }
    }
    if (segment < 0)
      break
    px += dx * nearest
    pz += dz * nearest
    points.push([px, pz])
    if (segment === count - 1)
      return { points, landing: null }
    const [ax, az] = outline[segment]!
    const [bx, bz] = outline[(segment + 1) % count]!
    const length = Math.hypot(bx - ax, bz - az)
    let nx = (bz - az) / length
    let nz = -(bx - ax) / length
    if (nx * dx + nz * dz > 0) {
      nx = -nx
      nz = -nz
    }
    const eta = inside
      ? ior
      : 1 / ior
    const cosine = -(nx * dx + nz * dz)
    const k = 1 - eta * eta * (1 - cosine * cosine)
    if (k < 0) {
      if (bounced)
        return { points, landing: null }
      dx += 2 * cosine * nx
      dz += 2 * cosine * nz
      bounced = true
    }
    else {
      const factor = eta * cosine - Math.sqrt(k)
      dx = eta * dx + factor * nx
      dz = eta * dz + factor * nz
      inside = !inside
    }
    const norm = Math.hypot(dx, dz)
    dx /= norm
    dz /= norm
    px += dx * EPSILON
    pz += dz * EPSILON
    if (!inside)
      break
  }
  if (inside || dz >= -EPSILON)
    return { points, landing: null }
  const travel = -pz / dz
  const landing = px + dx * travel
  points.push([landing, 0])
  return { points, landing }
}

function intersect(px: number, pz: number, dx: number, dz: number, ax: number, az: number, bx: number, bz: number): number | null {
  const ex = bx - ax
  const ez = bz - az
  const denominator = dx * ez - dz * ex
  if (Math.abs(denominator) < 1e-12)
    return null
  const wx = ax - px
  const wz = az - pz
  const t = (wx * ez - wz * ex) / denominator
  const s = (wx * dz - wz * dx) / denominator
  if (t <= EPSILON || s < 0 || s > 1)
    return null
  return t
}
