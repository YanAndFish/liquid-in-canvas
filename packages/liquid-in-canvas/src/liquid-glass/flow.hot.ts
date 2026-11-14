/** 一块玻璃体积的位置与尺寸，单位为 CSS 像素。 */
export interface FlowRect {
  left: number
  top: number
  width: number
  height: number
}

/** 两条边相同、只改变尺寸时使用的刚度，也用于静止尺寸。 */
const BASE_STIFFNESS = 300
/** 拉伸为 1 时前缘与后缘的刚度相对 `BASE_STIFFNESS` 的倍数；拉伸按指数缩放这两个倍数。 */
const LEADING_RATIO = 520 / 300
const TRAILING_RATIO = 170 / 300
/** 回弹为 1 时前缘与后缘的阻尼比，回弹为 0 时都是临界阻尼。 */
const LEADING_BOUNCY_DAMPING = 0.4
const TRAILING_BOUNCY_DAMPING = 0.76
/** 拉伸时另一个方向收窄的程度。1 表示面积不变，液滴会细得盖不住控件上的文字。 */
const SQUASH = 0.5
/** 晃动弹簧的刚度，约 2.5 Hz。 */
const WOBBLE_STIFFNESS = 240
/** 晃动为 0 与 1 时形变弹簧的阻尼比。 */
const WOBBLE_DAMPING_CALM = 0.5
const WOBBLE_DAMPING_LOOSE = 0.14
/** 晃动为 1 时中心减速度（像素每二次方秒）对形变的驱动系数，以及形变的上限。 */
const WOBBLE_GAIN = 0.00012
const WOBBLE_LIMIT = 0.4
/**
 * 两次改变目标的间隔不超过它时视为连续跟随（例如拖动），单位秒。
 * 连续跟随时弹簧同时追随目标的速度，本体不会被甩在后面；超过它没有新目标就当作松手。
 */
const TRACK_WINDOW = 0.05
/** 连续跟随时四条边共用的刚度。比跳变时更硬，松手后越过目标的距离与控件尺寸相称；拉长交给拖尾。 */
const TRACK_STIFFNESS = 900
/** 拖尾的刚度与回弹为 0、1 时的阻尼比。拖尾不追随目标速度，速度越快落后越多。 */
const TAIL_STIFFNESS = 140
const TAIL_DAMPING_CALM = 0.95
const TAIL_DAMPING_BOUNCY = 0.3
/** 拉伸为 1 时拖尾中心离本体中心的最远距离，相对本体短边。 */
const TAIL_REACH = 0.9
/** 拖尾的直径相对本体短边的比例，以及拉到最远时再缩小的比例。 */
const TAIL_SIZE = 0.74
const TAIL_TAPER = 0.3
/**
 * 渐进融合距离与两块体积中心距离之比，见 `rampedFusion()`。
 */
const FUSION_PER_DISTANCE = 0.8

/**
 * 两块相互重叠、正在分开或合拢的体积之间使用的融合距离：随中心距离增大，不超过 `limit`。
 *
 * 平滑合并在两块形状相距不到融合距离时就会鼓起，一块还在另一块里面时也一样。
 * 拖尾刚出现、面板刚从按钮里长出来、收起的面板快要并回按钮时，如果用玻璃自身的融合距离，
 * 整块玻璃会突然变大一圈，结束时又突然缩回。
 */
export function rampedFusion(limit: number, distance: number): number {
  return Math.min(limit, Math.max(0.5, distance * FUSION_PER_DISTANCE))
}
/** 拖尾离本体中心小于它时不绘制。 */
const TAIL_VISIBLE = 0.75
/** 位移小于它时视为没有移动。 */
const MOVE_EPSILON = 0.5
/** 距离与速度都小于它们时视为静止。 */
const REST_DISTANCE = 0.05
const REST_SPEED = 0.5
const REST_STRAIN = 0.0005
const REST_STRAIN_SPEED = 0.005
/** 推进时的子步长，使 30 Hz 与 120 Hz 下的轨迹接近。 */
const SUBSTEP = 1 / 240

/** 一条边或一个尺寸的弹簧。 */
class EdgeSpring {
  value: number
  velocity = 0
  target: number
  /** 连续跟随时目标的移动速度，弹簧的阻尼以它为参照。 */
  targetVelocity = 0
  /** 上一次推进以来目标的位移。 */
  shift = 0
  stiffness = BASE_STIFFNESS
  damping = 2 * Math.sqrt(BASE_STIFFNESS) * 0.8

  constructor(value: number) {
    this.value = value
    this.target = value
  }

  /** 设置刚度、阻尼比与目标。 */
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

  /** 由目标的位移估计目标速度；`interval` 为 0 表示这次是跳变，不估计速度。 */
  track(interval: number): void {
    const measured = interval > 0
      ? this.shift / interval
      : 0
    this.targetVelocity = interval > 0
      ? this.targetVelocity * 0.4 + measured * 0.6
      : 0
    this.shift = 0
  }

  /** 推进一个长为 `step` 的子步。 */
  step(step: number): void {
    this.velocity += ((this.target - this.value) * this.stiffness + (this.targetVelocity - this.velocity) * this.damping) * step
    this.value += this.velocity * step
  }

  /** 到达目标后停下，返回是否仍在运动。 */
  settle(): boolean {
    if (this.targetVelocity === 0 && Math.abs(this.target - this.value) < REST_DISTANCE && Math.abs(this.velocity) < REST_SPEED) {
      this.snap(this.target)
      return false
    }
    return true
  }
}

/**
 * 玻璃体积从一个矩形流向另一个矩形时的形状。
 *
 * 本体的四条边各有一根弹簧。目标跳变时（例如标签切换），朝运动方向的边刚度大，先到达；
 * 背向的边刚度小，被拖在后面，体积先被拉长再收拢，到达时前缘越过目标后回弹。
 * 目标连续移动时（例如拖动），弹簧同时追随目标的速度，本体紧跟元素；松手后带着速度越过目标再弹回。
 * 拉长时另一个方向按 `SQUASH` 收窄，压缩时鼓起。
 *
 * 拖尾是本体后面一团较小的圆形体积，只在连续跟随（拖动）时脱离本体。它只追随本体的位置、
 * 不追随速度，运动越快落后越多，最远不超过 `TAIL_REACH`。它与本体平滑融合，沿真实的运动方向
 * （包括斜向）拉出液滴的形状；停下后被拉回本体并越过它，像液体晃荡。
 *
 * 一根形变弹簧表示本体沿运动方向的晃动，由中心的减速驱动：到达时沿运动方向被压扁、向两侧鼓起，
 * 随后在拉长与压扁之间来回振荡几次再静止。它只是对液体外形的近似，没有模拟流体。
 *
 * `configure()` 设置拉伸、回弹与晃动的强度，从下一次改变目标起生效（晃动与拖尾立即生效）。
 */
export class LiquidFlow {
  private readonly left: EdgeSpring
  private readonly top: EdgeSpring
  private readonly right: EdgeSpring
  private readonly bottom: EdgeSpring
  /** 不受拉伸影响的静止尺寸，用来判断体积被拉长了多少。 */
  private readonly restWidth: EdgeSpring
  private readonly restHeight: EdgeSpring
  /** 沿运动方向的晃动形变（对数尺度），正值为沿运动方向拉长，0 表示没有形变。 */
  private strain = 0
  private strainVelocity = 0
  /** 拖尾中心与速度。 */
  private tailX: number
  private tailY: number
  private tailVelocityX = 0
  private tailVelocityY = 0
  /** 最近一次改变目标时中心移动方向的单位向量，没有移动时为零向量。 */
  private directionX = 0
  private directionY = 0
  /** 距上一次改变目标的时间，静止后为无穷大。 */
  private sinceRetarget = Infinity
  /** 上一次推进以来是否改变过目标，以及那次改变与再上一次的间隔。 */
  private retargeted = false
  private retargetInterval = 0
  /** 弹簧是否正在追随目标速度。 */
  private tracking = false
  /** 拖尾是否脱离本体。只有连续跟随会让它脱离；跳变（例如标签切换、面板展开）时它贴着本体中心。 */
  private tailFree = false
  private moving = false
  private stretch = 1
  private bounce = 1 / 3
  private wobble = 0

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

  /** 是否仍在运动。 */
  get active(): boolean {
    return this.moving
  }

  /**
   * 是否正在过渡尺寸：元素的尺寸变了，体积还没有到达新尺寸。
   * 舞台据此把内容限制在体积之内，内容随玻璃展开而显露；只是移动位置时不限制，
   * 否则拖动松手越过落点时内容会被切掉一角。
   */
  get resizing(): boolean {
    return this.moving
      && (Math.abs(this.restWidth.target - this.restWidth.value) >= MOVE_EPSILON
        || Math.abs(this.restHeight.target - this.restHeight.value) >= MOVE_EPSILON)
  }

  /**
   * 设置流动的手感。
   * `stretch`：前后缘的速度差与拖尾的长度，0 表示整体平移，1 为默认，越大拖得越长。
   * `bounce`：越过目标后回弹的程度，0 表示不越过。
   * `wobble`：液滴停下后来回晃动的程度，0 表示不晃动。
   */
  configure(stretch: number, bounce: number, wobble: number): void {
    this.stretch = Math.max(0, stretch)
    this.bounce = Math.min(1, Math.max(0, bounce))
    this.wobble = Math.min(1, Math.max(0, wobble))
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
    const shiftX = target.left + right - this.left.target - this.right.target
    const shiftY = target.top + bottom - this.top.target - this.bottom.target
    const shift = Math.hypot(shiftX, shiftY)
    if (shift >= MOVE_EPSILON) {
      this.directionX = shiftX / shift
      this.directionY = shiftY / shift
    }
    // 两次改变目标相隔很短才算连续跟随；静止后的第一次总是跳变。
    const tracking = this.sinceRetarget <= TRACK_WINDOW
    this.retargetInterval = tracking
      ? Math.max(this.sinceRetarget, SUBSTEP)
      : 0
    const leadingDamping = 1 - (1 - LEADING_BOUNCY_DAMPING) * this.bounce
    const trailingDamping = 1 - (1 - TRAILING_BOUNCY_DAMPING) * this.bounce
    const leading = tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * LEADING_RATIO ** this.stretch
    const trailing = tracking
      ? TRACK_STIFFNESS
      : BASE_STIFFNESS * TRAILING_RATIO ** this.stretch
    aim(this.left, this.right, target.left, right, leading, trailing, leadingDamping, tracking ? leadingDamping : trailingDamping)
    aim(this.top, this.bottom, target.top, bottom, leading, trailing, leadingDamping, tracking ? leadingDamping : trailingDamping)
    this.restWidth.aim(BASE_STIFFNESS, leadingDamping, target.width)
    this.restHeight.aim(BASE_STIFFNESS, leadingDamping, target.height)
    this.retargeted = true
    this.sinceRetarget = 0
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
  }

  /** 推进 `seconds` 秒，返回是否仍在运动。限制单步时长，避免切回后台标签页时发生跳变。 */
  advance(seconds: number): boolean {
    if (!this.moving)
      return false
    const dt = Math.min(Math.max(seconds, 0), 1 / 30)
    // 动画循环重新开始的第一帧可能没有经过时间（帧时间戳早于启动时刻），不推进，
    // 否则下面按子步长求加速度会除以零，NaN 会留在形变里，玻璃从此画不出来。
    if (!(dt > 0))
      return true
    if (this.retargeted) {
      this.retargeted = false
      this.trackAll(this.retargetInterval)
    }
    else if (this.sinceRetarget + dt > TRACK_WINDOW) {
      // 一段时间没有新目标：松手，弹簧不再追随目标速度。
      this.trackAll(0)
    }
    else if (this.sinceRetarget + dt > this.retargetInterval * 1.5) {
      // 预期的新目标没有按时到来：可能正在减速，目标速度减半而不清零。
      // 指针事件比画面帧稀疏时（例如 60 Hz 事件、120 Hz 画面），间隔之内的空帧不算。
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
      // 只有沿运动方向的减速压扁液滴；形变弹簧阻尼很小，停下后继续振荡。
      const acceleration = ((this.left.velocity + this.right.velocity - velocityX) * this.directionX
        + (this.top.velocity + this.bottom.velocity - velocityY) * this.directionY) * 0.5 / step
      // 连续跟随时逐帧的速度起伏不算减速，松手后才驱动形变。
      const force = this.tracking
        ? 0
        : Math.min(0, acceleration) * gain
      this.strainVelocity += ((force - this.strain) * WOBBLE_STIFFNESS - this.strainVelocity * strainDamping) * step
      this.strain = Math.min(WOBBLE_LIMIT, Math.max(-WOBBLE_LIMIT, this.strain + this.strainVelocity * step))
      this.stepTail(step, tailDamping)
    }
    // 每根弹簧都要检查，不能短路。
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

  /** 把当前的本体矩形写进 `out`，已包含拉伸带来的收窄与晃动形变。 */
  rect(out: FlowRect): void {
    const width = Math.max(1, this.right.value - this.left.value)
    const height = Math.max(1, this.bottom.value - this.top.value)
    const stretchX = width / Math.max(1, this.restWidth.value)
    const stretchY = height / Math.max(1, this.restHeight.value)
    // 一个方向被拉长到 s 倍时，面积不变的液滴在另一个方向缩到 1/√s。
    const squashedWidth = width * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchY, 0.25))))
    const squashedHeight = height * (1 - SQUASH * (1 - 1 / Math.sqrt(Math.max(stretchX, 0.25))))
    // 晃动形变沿运动方向拉长时，垂直方向按一半的比例收窄；按方向分配到两个轴上。
    const alongX = this.directionX * this.directionX
    const alongY = this.directionY * this.directionY
    const wobbledWidth = squashedWidth * Math.exp(this.strain * (alongX - alongY * SQUASH))
    const wobbledHeight = squashedHeight * Math.exp(this.strain * (alongY - alongX * SQUASH))
    out.left = (this.left.value + this.right.value - wobbledWidth) / 2
    out.top = (this.top.value + this.bottom.value - wobbledHeight) / 2
    out.width = wobbledWidth
    out.height = wobbledHeight
  }

  /**
   * 把拖尾的矩形写进 `out`，返回拖尾是否可见。拖尾是一团圆形体积，离本体越远越小。
   * 拉伸为 0 或拖尾几乎与本体重合时不可见。
   */
  tail(out: FlowRect): boolean {
    const centerX = (this.left.value + this.right.value) / 2
    const centerY = (this.top.value + this.bottom.value) / 2
    const distance = Math.hypot(this.tailX - centerX, this.tailY - centerY)
    const reach = this.tailReach()
    if (!this.moving || reach <= 0 || distance < TAIL_VISIBLE)
      return false
    const size = Math.max(1, Math.min(this.restWidth.value, this.restHeight.value) * TAIL_SIZE * (1 - TAIL_TAPER * Math.min(1, distance / reach)))
    out.left = this.tailX - size / 2
    out.top = this.tailY - size / 2
    out.width = size
    out.height = size
    return true
  }

  /** 拖尾与本体之间的融合距离：随拖尾离开本体逐渐增大，不超过 `limit`。 */
  tailFusion(limit: number): number {
    const distance = Math.hypot(this.tailX - (this.left.value + this.right.value) / 2, this.tailY - (this.top.value + this.bottom.value) / 2)
    return rampedFusion(limit, distance)
  }

  /** 拖尾中心离本体中心的最远距离。 */
  private tailReach(): number {
    return this.stretch * TAIL_REACH * Math.min(this.restWidth.value, this.restHeight.value)
  }

  /** 拖尾朝本体中心推进一个子步，并限制在 `tailReach()` 之内。 */
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
    const reach = this.tailReach()
    if (distance <= reach || distance === 0)
      return
    // 拉到最远时像被系住：拖尾停在边界上，去掉继续远离本体的速度分量。
    const unitX = offsetX / distance
    const unitY = offsetY / distance
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

/** 按中心的移动方向分配一对边的弹簧：朝运动方向的边用前缘参数，另一条用后缘参数。 */
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
