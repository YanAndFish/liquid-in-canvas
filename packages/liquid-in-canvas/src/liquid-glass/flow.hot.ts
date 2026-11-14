/** 一块玻璃体积的位置与尺寸，单位为 CSS 像素。 */
export interface FlowRect {
  left: number
  top: number
  width: number
  height: number
}

/** 弹簧的刚度与阻尼。 */
interface SpringKind {
  stiffness: number
  damping: number
}

/** 朝运动方向的那条边：先到，略微越过目标再回弹（阻尼比 0.8）。 */
const LEADING: SpringKind = { stiffness: 520, damping: 2 * Math.sqrt(520) * 0.8 }
/** 背向运动方向的那条边：后到，被前缘拖着走，几乎不回弹（阻尼比 0.92）。 */
const TRAILING: SpringKind = { stiffness: 170, damping: 2 * Math.sqrt(170) * 0.92 }
/** 位置不变、只改变尺寸时两条边使用的弹簧，也用于静止尺寸（阻尼比 0.8）。 */
const NEUTRAL: SpringKind = { stiffness: 300, damping: 2 * Math.sqrt(300) * 0.8 }
/** 拉伸时另一个方向收窄的程度。1 表示面积不变，液滴会细得盖不住控件上的文字。 */
const SQUASH = 0.5
/** 位移小于它时视为没有移动。 */
const MOVE_EPSILON = 0.5
/** 距离与速度都小于它们时视为静止。 */
const REST_DISTANCE = 0.05
const REST_SPEED = 0.5
/** 推进时的子步长，使 30 Hz 与 120 Hz 下的轨迹接近。 */
const SUBSTEP = 1 / 240

/** 一条边或一个尺寸的弹簧。 */
class EdgeSpring {
  value: number
  velocity = 0
  target: number
  stiffness = NEUTRAL.stiffness
  damping = NEUTRAL.damping

  constructor(value: number) {
    this.value = value
    this.target = value
  }

  aim(kind: SpringKind, target: number): void {
    this.stiffness = kind.stiffness
    this.damping = kind.damping
    this.target = target
  }

  snap(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  /** 推进 `steps` 个长为 `step` 的子步，返回是否仍在运动。 */
  advance(step: number, steps: number): boolean {
    for (let i = 0; i < steps; i++) {
      this.velocity += ((this.target - this.value) * this.stiffness - this.velocity * this.damping) * step
      this.value += this.velocity * step
    }
    if (Math.abs(this.target - this.value) < REST_DISTANCE && Math.abs(this.velocity) < REST_SPEED) {
      this.snap(this.target)
      return false
    }
    return true
  }
}

/**
 * 玻璃体积从一个矩形流向另一个矩形时的形状。
 *
 * 四条边各有一根弹簧。朝运动方向的边刚度大，先到达；背向的边刚度小，被拖在后面。
 * 体积因此先被拉长，尾部再收拢，到达时前缘略微越过目标后回弹，像一滴液体被推到新位置。
 * 拉长时另一个方向按 `SQUASH` 收窄，压缩时鼓起。它只是对液体外形的近似，没有模拟流体。
 */
export class LiquidFlow {
  private readonly left: EdgeSpring
  private readonly top: EdgeSpring
  private readonly right: EdgeSpring
  private readonly bottom: EdgeSpring
  /** 不受拉伸影响的静止尺寸，用来判断体积被拉长了多少。 */
  private readonly restWidth: EdgeSpring
  private readonly restHeight: EdgeSpring
  private moving = false

  constructor(start: FlowRect) {
    this.left = new EdgeSpring(start.left)
    this.top = new EdgeSpring(start.top)
    this.right = new EdgeSpring(start.left + start.width)
    this.bottom = new EdgeSpring(start.top + start.height)
    this.restWidth = new EdgeSpring(start.width)
    this.restHeight = new EdgeSpring(start.height)
  }

  /** 是否仍在运动。 */
  get active(): boolean {
    return this.moving
  }

  /** 设置新的目标矩形。与当前目标相同时不做任何事，返回是否开始了新的运动。 */
  retarget(target: FlowRect): boolean {
    const right = target.left + target.width
    const bottom = target.top + target.height
    if (Math.abs(target.left - this.left.target) < MOVE_EPSILON
      && Math.abs(target.top - this.top.target) < MOVE_EPSILON
      && Math.abs(right - this.right.target) < MOVE_EPSILON
      && Math.abs(bottom - this.bottom.target) < MOVE_EPSILON) {
      return false
    }
    aim(this.left, this.right, target.left, right)
    aim(this.top, this.bottom, target.top, bottom)
    this.restWidth.aim(NEUTRAL, target.width)
    this.restHeight.aim(NEUTRAL, target.height)
    this.moving = true
    return true
  }

  /** 直接到达目标，不经过运动。 */
  snap(target: FlowRect): void {
    this.left.snap(target.left)
    this.top.snap(target.top)
    this.right.snap(target.left + target.width)
    this.bottom.snap(target.top + target.height)
    this.restWidth.snap(target.width)
    this.restHeight.snap(target.height)
    this.moving = false
  }

  /** 推进 `seconds` 秒，返回是否仍在运动。限制单步时长，避免切回后台标签页时发生跳变。 */
  advance(seconds: number): boolean {
    if (!this.moving)
      return false
    const dt = Math.min(Math.max(seconds, 0), 1 / 30)
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP))
    const step = dt / steps
    // 每根弹簧都要推进，不能短路。
    let moving = this.left.advance(step, steps)
    moving = this.top.advance(step, steps) || moving
    moving = this.right.advance(step, steps) || moving
    moving = this.bottom.advance(step, steps) || moving
    moving = this.restWidth.advance(step, steps) || moving
    moving = this.restHeight.advance(step, steps) || moving
    this.moving = moving
    return moving
  }

  /** 把当前的体积矩形写进 `out`，已包含拉伸带来的收窄。 */
  rect(out: FlowRect): void {
    const width = Math.max(1, this.right.value - this.left.value)
    const height = Math.max(1, this.bottom.value - this.top.value)
    const stretchX = width / Math.max(1, this.restWidth.value)
    const stretchY = height / Math.max(1, this.restHeight.value)
    // 一个方向被拉长到 s 倍时，面积不变的液滴在另一个方向缩到 1/√s。
    const squashedWidth = width * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchY, 0.25))))
    const squashedHeight = height * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchX, 0.25))))
    out.left = (this.left.value + this.right.value - squashedWidth) / 2
    out.top = (this.top.value + this.bottom.value - squashedHeight) / 2
    out.width = squashedWidth
    out.height = squashedHeight
  }
}

/** 按中心的移动方向分配一对边的弹簧：朝运动方向的边用 `LEADING`，另一条用 `TRAILING`。 */
function aim(low: EdgeSpring, high: EdgeSpring, lowTarget: number, highTarget: number): void {
  const shift = (lowTarget + highTarget) / 2 - (low.target + high.target) / 2
  if (Math.abs(shift) < MOVE_EPSILON) {
    low.aim(NEUTRAL, lowTarget)
    high.aim(NEUTRAL, highTarget)
  }
  else if (shift > 0) {
    low.aim(TRAILING, lowTarget)
    high.aim(LEADING, highTarget)
  }
  else {
    low.aim(LEADING, lowTarget)
    high.aim(TRAILING, highTarget)
  }
}
