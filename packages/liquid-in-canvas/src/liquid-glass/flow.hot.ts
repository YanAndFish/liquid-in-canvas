export interface FlowRect {
  left: number
  top: number
  width: number
  height: number
}

const BASE_STIFFNESS = 300
const LEADING_RATIO = 520 / 300
const TRAILING_RATIO = 170 / 300
const LEADING_BOUNCY_DAMPING = 0.4
const TRAILING_BOUNCY_DAMPING = 0.76
const SQUASH = 0.5
const WOBBLE_STIFFNESS = 240
const WOBBLE_DAMPING_CALM = 0.5
const WOBBLE_DAMPING_LOOSE = 0.14
const WOBBLE_GAIN = 0.00012
const WOBBLE_LIMIT = 0.4
const TRACK_WINDOW = 0.05
const TRACK_STIFFNESS = 900
const TAIL_STIFFNESS = 140
const TAIL_DAMPING_CALM = 0.95
const TAIL_DAMPING_BOUNCY = 0.3
const TAIL_REACH = 0.9
const TAIL_SIZE = 0.74
const TAIL_TAPER = 0.3
const FUSION_PER_DISTANCE = 0.8

export function rampedFusion(limit: number, distance: number): number {
  return Math.min(limit, Math.max(0.5, distance * FUSION_PER_DISTANCE))
}
const TAIL_VISIBLE = 0.75
const JUMP_TAIL = 0.25
const TAIL_JOIN = 0.2
const MOVE_EPSILON = 0.5
const REST_DISTANCE = 0.05
const REST_SPEED = 0.5
const REST_STRAIN = 0.0005
const REST_STRAIN_SPEED = 0.005
const SUBSTEP = 1 / 240

class EdgeSpring {
  value: number
  velocity = 0
  target: number
  targetVelocity = 0
  shift = 0
  stiffness = BASE_STIFFNESS
  damping = 2 * Math.sqrt(BASE_STIFFNESS) * 0.8

  constructor(value: number) {
    this.value = value
    this.target = value
  }

  aim(stiffness: number, ratio: number, target: number): void {
    this.stiffness = stiffness
    this.damping = 2 * Math.sqrt(stiffness) * ratio
    this.shift += target - this.target
    this.target = target
  }

  snap(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
    this.targetVelocity = 0
    this.shift = 0
  }

  track(interval: number): void {
    const measured = interval > 0
      ? this.shift / interval
      : 0
    this.targetVelocity = interval > 0
      ? this.targetVelocity * 0.4 + measured * 0.6
      : 0
    this.shift = 0
  }

  step(step: number): void {
    this.velocity += ((this.target - this.value) * this.stiffness + (this.targetVelocity - this.velocity) * this.damping) * step
    this.value += this.velocity * step
  }

  settle(): boolean {
    if (this.targetVelocity === 0 && Math.abs(this.target - this.value) < REST_DISTANCE && Math.abs(this.velocity) < REST_SPEED) {
      this.snap(this.target)
      return false
    }
    return true
  }
}

export class LiquidFlow {
  private readonly left: EdgeSpring
  private readonly top: EdgeSpring
  private readonly right: EdgeSpring
  private readonly bottom: EdgeSpring
  private readonly restWidth: EdgeSpring
  private readonly restHeight: EdgeSpring
  private strain = 0
  private strainVelocity = 0
  private tailX: number
  private tailY: number
  private tailVelocityX = 0
  private tailVelocityY = 0
  private directionX = 0
  private directionY = 0
  private sinceRetarget = Infinity
  private retargeted = false
  private retargetInterval = 0
  private tracking = false
  private tailFree = false
  private moving = false
  private stretch = 1
  private bounce = 1 / 3
  private wobble = 0
  private join = 0
  private radius = 0
  private span = 0

  constructor(start: FlowRect) {
    this.left = new EdgeSpring(start.left)
    this.top = new EdgeSpring(start.top)
    this.right = new EdgeSpring(start.left + start.width)
    this.bottom = new EdgeSpring(start.top + start.height)
    this.restWidth = new EdgeSpring(start.width)
    this.restHeight = new EdgeSpring(start.height)
    this.tailX = start.left + start.width / 2
    this.tailY = start.top + start.height / 2
  }

  get active(): boolean {
    return this.moving
  }

  get resizing(): boolean {
    return this.moving
      && (Math.abs(this.restWidth.target - this.restWidth.value) >= MOVE_EPSILON
        || Math.abs(this.restHeight.target - this.restHeight.value) >= MOVE_EPSILON)
  }

  progress(): number {
    if (!this.moving || this.span <= 0)
      return 1
    return Math.min(1, Math.max(0, 1 - this.remaining() / this.span))
  }

  configure(stretch: number, bounce: number, wobble: number, join = 0, radius = 0): void {
    this.join = Math.max(0, join)
    this.radius = Math.max(0, radius)
    this.stretch = Math.max(0, stretch)
    this.bounce = Math.min(1, Math.max(0, bounce))
    this.wobble = Math.min(1, Math.max(0, wobble))
  }

  retarget(target: FlowRect): boolean {
    const right = target.left + target.width
    const bottom = target.top + target.height
    if (Math.abs(target.left - this.left.target) < MOVE_EPSILON
      && Math.abs(target.top - this.top.target) < MOVE_EPSILON
      && Math.abs(right - this.right.target) < MOVE_EPSILON
      && Math.abs(bottom - this.bottom.target) < MOVE_EPSILON) {
      return false
    }
    const shiftX = target.left + right - this.left.target - this.right.target
    const shiftY = target.top + bottom - this.top.target - this.bottom.target
    const shift = Math.hypot(shiftX, shiftY)
    if (shift >= MOVE_EPSILON) {
      this.directionX = shiftX / shift
      this.directionY = shiftY / shift
    }
    const tracking = this.sinceRetarget <= TRACK_WINDOW
    this.retargetInterval = tracking
      ? Math.max(this.sinceRetarget, SUBSTEP)
      : 0
    const leadingDamping = 1 - (1 - LEADING_BOUNCY_DAMPING) * this.bounce
    const trailingDamping = 1 - (1 - TRAILING_BOUNCY_DAMPING) * this.bounce
    const alongX = this.directionX * this.directionX
    const alongY = this.directionY * this.directionY
    const stretchX = this.stretch * Math.max(0, alongX - alongY)
    const stretchY = this.stretch * Math.max(0, alongY - alongX)
    aim(this.left, this.right, target.left, right, tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * LEADING_RATIO ** stretchX, tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * TRAILING_RATIO ** stretchX, leadingDamping, tracking ? leadingDamping : trailingDamping)
    aim(this.top, this.bottom, target.top, bottom, tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * LEADING_RATIO ** stretchY, tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * TRAILING_RATIO ** stretchY, leadingDamping, tracking ? leadingDamping : trailingDamping)
    this.restWidth.aim(BASE_STIFFNESS, leadingDamping, target.width)
    this.restHeight.aim(BASE_STIFFNESS, leadingDamping, target.height)
    if (!tracking && this.departs(target) && shift / 2 >= JUMP_TAIL * Math.min(target.width, target.height, this.restWidth.value, this.restHeight.value))
      this.tailFree = true
    this.retargeted = true
    this.sinceRetarget = 0
    this.moving = true
    if (!tracking)
      this.span = this.remaining()
    return true
  }

  snap(target: FlowRect): void {
    this.left.snap(target.left)
    this.top.snap(target.top)
    this.right.snap(target.left + target.width)
    this.bottom.snap(target.top + target.height)
    this.restWidth.snap(target.width)
    this.restHeight.snap(target.height)
    this.strain = 0
    this.strainVelocity = 0
    this.tailX = target.left + target.width / 2
    this.tailY = target.top + target.height / 2
    this.tailVelocityX = 0
    this.tailVelocityY = 0
    this.tailFree = false
    this.directionX = 0
    this.directionY = 0
    this.sinceRetarget = Infinity
    this.retargeted = false
    this.tracking = false
    this.moving = false
    this.span = 0
  }

  advance(seconds: number): boolean {
    if (!this.moving)
      return false
    const dt = Math.min(Math.max(seconds, 0), 1 / 30)
    if (!(dt > 0))
      return true
    if (this.retargeted) {
      this.retargeted = false
      this.trackAll(this.retargetInterval)
    }
    else if (this.sinceRetarget + dt > TRACK_WINDOW) {
      this.trackAll(0)
    }
    else if (this.sinceRetarget + dt > this.retargetInterval * 1.5) {
      this.fadeAll()
    }
    this.sinceRetarget += dt
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP))
    const step = dt / steps
    const gain = WOBBLE_GAIN * this.wobble
    const strainDamping = 2 * Math.sqrt(WOBBLE_STIFFNESS) * (WOBBLE_DAMPING_CALM + (WOBBLE_DAMPING_LOOSE - WOBBLE_DAMPING_CALM) * this.wobble)
    const tailDamping = 2 * Math.sqrt(TAIL_STIFFNESS) * (TAIL_DAMPING_CALM + (TAIL_DAMPING_BOUNCY - TAIL_DAMPING_CALM) * this.bounce)
    for (let i = 0; i < steps; i++) {
      const velocityX = this.left.velocity + this.right.velocity
      const velocityY = this.top.velocity + this.bottom.velocity
      this.left.step(step)
      this.top.step(step)
      this.right.step(step)
      this.bottom.step(step)
      this.restWidth.step(step)
      this.restHeight.step(step)
      const acceleration = ((this.left.velocity + this.right.velocity - velocityX) * this.directionX
        + (this.top.velocity + this.bottom.velocity - velocityY) * this.directionY) * 0.5 / step
      const force = this.tracking
        ? 0
        : Math.min(0, acceleration) * gain
      this.strainVelocity += ((force - this.strain) * WOBBLE_STIFFNESS - this.strainVelocity * strainDamping) * step
      this.strain = Math.min(WOBBLE_LIMIT, Math.max(-WOBBLE_LIMIT, this.strain + this.strainVelocity * step))
      this.stepTail(step, tailDamping)
    }
    let moving = this.left.settle()
    moving = this.top.settle() || moving
    moving = this.right.settle() || moving
    moving = this.bottom.settle() || moving
    moving = this.restWidth.settle() || moving
    moving = this.restHeight.settle() || moving
    const centerX = (this.left.value + this.right.value) / 2
    const centerY = (this.top.value + this.bottom.value) / 2
    if (!moving
      && Math.abs(this.strain) < REST_STRAIN && Math.abs(this.strainVelocity) < REST_STRAIN_SPEED
      && Math.hypot(this.tailX - centerX, this.tailY - centerY) < REST_DISTANCE
      && Math.hypot(this.tailVelocityX, this.tailVelocityY) < REST_SPEED) {
      this.strain = 0
      this.strainVelocity = 0
      this.tailX = centerX
      this.tailY = centerY
      this.tailVelocityX = 0
      this.tailVelocityY = 0
      this.tailFree = false
      this.sinceRetarget = Infinity
    }
    else {
      moving = true
    }
    this.moving = moving
    return moving
  }

  rect(out: FlowRect): void {
    const width = Math.max(1, this.right.value - this.left.value)
    const height = Math.max(1, this.bottom.value - this.top.value)
    const stretchX = width / Math.max(1, this.restWidth.value)
    const stretchY = height / Math.max(1, this.restHeight.value)
    const squashedWidth = width * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchY, 0.25))))
    const squashedHeight = height * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchX, 0.25))))
    const alongX = this.directionX * this.directionX
    const alongY = this.directionY * this.directionY
    const wobbledWidth = squashedWidth * Math.exp(this.strain * (alongX - alongY * SQUASH))
    const wobbledHeight = squashedHeight * Math.exp(this.strain * (alongY - alongX * SQUASH))
    out.left = (this.left.value + this.right.value - wobbledWidth) / 2
    out.top = (this.top.value + this.bottom.value - wobbledHeight) / 2
    out.width = wobbledWidth
    out.height = wobbledHeight
  }

  tail(out: FlowRect): boolean {
    const centerX = (this.left.value + this.right.value) / 2
    const centerY = (this.top.value + this.bottom.value) / 2
    const distance = Math.hypot(this.tailX - centerX, this.tailY - centerY)
    if (!this.moving || this.stretch <= 0 || distance < TAIL_VISIBLE)
      return false
    const reach = this.tailReach((this.tailX - centerX) / distance, (this.tailY - centerY) / distance)
    if (reach <= 0)
      return false
    const scale = TAIL_SIZE * (1 - TAIL_TAPER * Math.min(1, distance / reach))
    const width = Math.max(1, this.restWidth.value * scale)
    const height = Math.max(1, this.restHeight.value * scale)
    out.left = this.tailX - width / 2
    out.top = this.tailY - height / 2
    out.width = width
    out.height = height
    return true
  }

  tailFusion(limit: number): number {
    const distance = Math.hypot(this.tailX - (this.left.value + this.right.value) / 2, this.tailY - (this.top.value + this.bottom.value) / 2)
    return rampedFusion(limit, distance)
  }

  private departs(target: FlowRect): boolean {
    const x = (this.left.value + this.right.value) / 2
    const y = (this.top.value + this.bottom.value) / 2
    return x < target.left || x > target.left + target.width || y < target.top || y > target.top + target.height
  }

  private remaining(): number {
    return Math.max(
      Math.abs(this.left.target - this.left.value),
      Math.abs(this.top.target - this.top.value),
      Math.abs(this.right.target - this.right.value),
      Math.abs(this.bottom.target - this.bottom.value),
    )
  }

  private tailReach(unitX: number, unitY: number): number {
    const width = this.restWidth.value
    const height = this.restHeight.value
    const bodyRadius = Math.min(this.radius, width / 2, height / 2)
    const scale = TAIL_SIZE * (1 - TAIL_TAPER)
    const tailRadius = Math.min(width, height) * scale / 2
    const coreX = width * (1 + scale) / 2 - bodyRadius - tailRadius
    const coreY = height * (1 + scale) / 2 - bodyRadius - tailRadius
    const round = bodyRadius + tailRadius + this.join * TAIL_JOIN
    const alongX = Math.abs(unitX)
    const alongY = Math.abs(unitY)
    const sideX = alongX > 0
      ? (coreX + round) / alongX
      : Infinity
    const sideY = alongY > 0
      ? (coreY + round) / alongY
      : Infinity
    let joined = Math.min(sideX, sideY)
    if (joined * alongX > coreX && joined * alongY > coreY) {
      const facing = alongX * coreX + alongY * coreY
      joined = facing + Math.sqrt(Math.max(facing * facing - coreX * coreX - coreY * coreY + round * round, 0))
    }
    return Math.min(this.stretch * TAIL_REACH * Math.min(width, height), joined)
  }

  private stepTail(step: number, damping: number): void {
    const centerX = (this.left.value + this.right.value) / 2
    const centerY = (this.top.value + this.bottom.value) / 2
    if (!this.tailFree) {
      this.tailX = centerX
      this.tailY = centerY
      this.tailVelocityX = (this.left.velocity + this.right.velocity) / 2
      this.tailVelocityY = (this.top.velocity + this.bottom.velocity) / 2
      return
    }
    this.tailVelocityX += ((centerX - this.tailX) * TAIL_STIFFNESS - this.tailVelocityX * damping) * step
    this.tailVelocityY += ((centerY - this.tailY) * TAIL_STIFFNESS - this.tailVelocityY * damping) * step
    this.tailX += this.tailVelocityX * step
    this.tailY += this.tailVelocityY * step
    const offsetX = this.tailX - centerX
    const offsetY = this.tailY - centerY
    const distance = Math.hypot(offsetX, offsetY)
    if (distance === 0)
      return
    const unitX = offsetX / distance
    const unitY = offsetY / distance
    const reach = this.tailReach(unitX, unitY)
    if (distance <= reach)
      return
    this.tailX = centerX + unitX * reach
    this.tailY = centerY + unitY * reach
    const outward = this.tailVelocityX * unitX + this.tailVelocityY * unitY
    const bodyOutward = ((this.left.velocity + this.right.velocity) * unitX + (this.top.velocity + this.bottom.velocity) * unitY) / 2
    if (outward > bodyOutward) {
      this.tailVelocityX -= (outward - bodyOutward) * unitX
      this.tailVelocityY -= (outward - bodyOutward) * unitY
    }
  }

  private fadeAll(): void {
    this.left.targetVelocity *= 0.5
    this.top.targetVelocity *= 0.5
    this.right.targetVelocity *= 0.5
    this.bottom.targetVelocity *= 0.5
    this.restWidth.targetVelocity *= 0.5
    this.restHeight.targetVelocity *= 0.5
  }

  private trackAll(interval: number): void {
    this.tracking = interval > 0
    if (this.tracking)
      this.tailFree = true
    this.left.track(interval)
    this.top.track(interval)
    this.right.track(interval)
    this.bottom.track(interval)
    this.restWidth.track(interval)
    this.restHeight.track(interval)
  }
}

function aim(
  low: EdgeSpring,
  high: EdgeSpring,
  lowTarget: number,
  highTarget: number,
  leading: number,
  trailing: number,
  leadingDamping: number,
  trailingDamping: number,
): void {
  const shift = (lowTarget + highTarget) / 2 - (low.target + high.target) / 2
  if (Math.abs(shift) < MOVE_EPSILON) {
    low.aim(BASE_STIFFNESS, leadingDamping, lowTarget)
    high.aim(BASE_STIFFNESS, leadingDamping, highTarget)
  }
  else if (shift > 0) {
    low.aim(trailing, trailingDamping, lowTarget)
    high.aim(leading, leadingDamping, highTarget)
  }
  else {
    low.aim(leading, leadingDamping, lowTarget)
    high.aim(trailing, trailingDamping, highTarget)
  }
}
