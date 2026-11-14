/** 截面图里的一条光路。 */
export interface ProfileRay {
  /** 依次经过的点：起点、各次折射或反射处、终点。 */
  points: [number, number][]
  /** 落在背景平面上的横坐标；光线没有到达背景时为 null。 */
  landing: number | null
}

/** 玻璃的折射率，与体积着色器中绿色光路一致。 */
const IOR = 1.45
const EPSILON = 1e-4
/** 最多经过的界面次数：入射、一次全内反射、出射，再留一点余量。 */
const MAX_EVENTS = 6

/**
 * 在二维截面里追踪竖直向下的光线。
 *
 * `outline` 是 `glassProfileOutline()` 的结果，首尾相连成闭合多边形，最后一段是画面右侧的截断，
 * 光线碰到它就停止。光线按 Snell 定律进出玻璃，与着色器一样最多允许一次全内反射，
 * 离开玻璃后走到背景平面 z = 0。
 */
export function traceProfileRays(outline: readonly [number, number][], starts: readonly number[], height: number): ProfileRay[] {
  return starts.map(x => traceRay(outline, x, height))
}

function traceRay(outline: readonly [number, number][], startX: number, height: number): ProfileRay {
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
    // 最后一段是画面截断，不是真实表面。
    if (segment === count - 1)
      return { points, landing: null }
    const [ax, az] = outline[segment]!
    const [bx, bz] = outline[(segment + 1) % count]!
    const length = Math.hypot(bx - ax, bz - az)
    let nx = (bz - az) / length
    let nz = -(bx - ax) / length
    // 法线朝向入射一侧。
    if (nx * dx + nz * dz > 0) {
      nx = -nx
      nz = -nz
    }
    const eta = inside
      ? IOR
      : 1 / IOR
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

/** 射线与线段的交点参数 t；不相交时返回 null。 */
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
