/** 一维弹簧的当前位置与每秒速度。 */
export interface SpringState {
  /** 当前值。 */
  value: number
  /** 每秒变化量。 */
  velocity: number
}

/**
 * 推进阻尼弹簧。限制单步时长，避免切回后台标签页时发生跳变。
 * 缺省的刚度与阻尼接近临界阻尼，只有很小的过冲。
 */
export function advanceSpring(state: SpringState, target: number, seconds: number, stiffness = 320, damping = 28): boolean {
  const dt = Math.min(Math.max(seconds, 0), 1 / 30)
  // 拆成小步，使 30 Hz 与 120 Hz 下的响应接近。
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const step = dt / steps
  for (let i = 0; i < steps; i++) {
    state.velocity += ((target - state.value) * stiffness - state.velocity * damping) * step
    state.value += state.velocity * step
  }
  if (Math.abs(target - state.value) < 0.001 && Math.abs(state.velocity) < 0.01) {
    state.value = target
    state.velocity = 0
    return false
  }
  return true
}
