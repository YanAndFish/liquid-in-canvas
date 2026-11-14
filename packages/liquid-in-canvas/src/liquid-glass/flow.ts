/** 一块玻璃体积的位置与尺寸，单位为 CSS 像素。 */
export interface FlowRect {
  left: number
  top: number
  width: number
  height: number
}

/** 一条边或一个尺寸的弹簧。 */
interface Edge {
  value: number
  velocity: number
  target: number
  /** 刚度与阻尼，每次重新定向时按运动方向设置。 */
  stiffness: number
  damping: number
}

/** 朝运动方向的那条边：先到，略微越过目标再回弹。 */
const LEADING = { stiffness: 520, ratio: 0.8 }
/** 背向运动方向的那条边：后到，被前缘拖着走，几乎不回弹。 */
const TRAILING = { stiffness: 170, ratio: 0.92 }
/** 位置不变、只改变尺寸时两条边使用的弹簧，也用于静止尺寸。 */
const NEUTRAL = { stiffness: 300, ratio: 0.8 }
/** 拉伸时另一个方向收窄的程度。1 表示面积不变，液滴会细得盖不住控件上的文字。 */
const SQUASH = 0.5
/** 位移小于它时视为没有移动。 */
const MOVE_EPSILON = 0.5
/** 距离与速度都小于它们时视为静止。 */
const REST_DISTANCE = 0.05
const REST_SPEED = 0.5

function edge(value: number): Edge {
  return {
    value,
    velocity: 0,
    target: value,
    ...spring(NEUTRAL),
  }
}

function spring(kind: { stiffness: number, ratio: number }): { stiffness: number, damping: number } {
  return { stiffness: kind.stiffness, damping: 2 * Math.sqrt(kind.stiffness) * kind.ratio }
}

/**
 * 玻璃体积从一个矩形流向另一个矩形时的形状。
 *
 * 四条边各有一根弹簧。朝运动方向的边刚度大，先到达；背向的边刚度小，被拖在后面。
 * 体积因此先被拉长，尾部再收拢，到达时前缘略微越过目标后回弹，像一滴液体被推到新位置。
 * 拉长时另一个方向按 `SQUASH` 收窄，压缩时鼓起。它只是对液体外形的近似，没有模拟流体。
 */
export class LiquidFlow {
  private readonly left: Edge
  private readonly top: Edge
  private readonly right: Edge
  private readonly bottom: Edge
  /** 不受拉伸影响的静止尺寸，用来判断体积被拉长了多少。 */
  private readonly restWidth: Edge
  private readonly restHeight: Edge
  private moving = false

  constructor(start: FlowRect) {
    this.left = edge(start.left)
    this.top = edge(start.top)
    this.right = edge(start.left + start.width)
    this.bottom = edge(start.top + start.height)
    this.restWidth = edge(start.width)
    this.restHeight = edge(start.height)
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
    this.aim(this.left, this.right, target.left, right)
    this.aim(this.top, this.bottom, target.top, bottom)
    this.restWidth.target = target.width
    this.restHeight.target = target.height
    this.moving = true
    return true
  }

  /** 直接到达目标，不经过运动。 */
  snap(target: FlowRect): void {
    const values = [
      [this.left, target.left],
      [this.top, target.top],
      [this.right, target.left + target.width],
      [this.bottom, target.top + target.height],
      [this.restWidth, target.width],
      [this.restHeight, target.height],
    ] as const
    for (const [side, value] of values) {
      side.value = value
      side.target = value
      side.velocity = 0
    }
    this.moving = false
  }

  /** 推进 `seconds` 秒，返回是否仍在运动。限制单步时长，避免切回后台标签页时发生跳变。 */
  advance(seconds: number): boolean {
    if (!this.moving)
      return false
    const dt = Math.min(Math.max(seconds, 0), 1 / 30)
    // 拆成小步，使 30 Hz 与 120 Hz 下的响应接近。
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
    const step = dt / steps
    const sides = [
      this.left,
      this.top,
      this.right,
      this.bottom,
      this.restWidth,
      this.restHeight,
    ]
    let moving = false
    for (const side of sides) {
      for (let i = 0; i < steps; i++) {
        side.velocity += ((side.target - side.value) * side.stiffness - side.velocity * side.damping) * step
        side.value += side.velocity * step
      }
      if (Math.abs(side.target - side.value) < REST_DISTANCE && Math.abs(side.velocity) < REST_SPEED) {
        side.value = side.target
        side.velocity = 0
      }
      else {
        moving = true
      }
    }
    this.moving = moving
    return moving
  }

  /** 当前的体积矩形，已包含拉伸带来的收窄。 */
  rect(): FlowRect {
    const width = Math.max(1, this.right.value - this.left.value)
    const height = Math.max(1, this.bottom.value - this.top.value)
    const stretchX = width / Math.max(1, this.restWidth.value)
    const stretchY = height / Math.max(1, this.restHeight.value)
    // 一个方向被拉长到 s 倍时，面积不变的液滴在另一个方向缩到 1/√s。
    const squashedWidth = width * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchY, 0.25))))
    const squashedHeight = height * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchX, 0.25))))
    return {
      left: (this.left.value + this.right.value - squashedWidth) / 2,
      top: (this.top.value + this.bottom.value - squashedHeight) / 2,
      width: squashedWidth,
      height: squashedHeight,
    }
  }

  /** 按中心的移动方向分配一对边的弹簧。 */
  private aim(low: Edge, high: Edge, lowTarget: number, highTarget: number): void {
    const shift = (lowTarget + highTarget) / 2 - (low.target + high.target) / 2
    const [lowKind, highKind] = Math.abs(shift) < MOVE_EPSILON
      ? [NEUTRAL, NEUTRAL]
      : shift > 0
        ? [TRAILING, LEADING]
        : [LEADING, TRAILING]
    Object.assign(low, spring(lowKind), { target: lowTarget })
    Object.assign(high, spring(highKind), { target: highTarget })
  }
}
