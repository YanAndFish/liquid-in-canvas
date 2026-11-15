/**
 * 自适应降级：依次尝试把光路降为查表、降低玻璃着色倍率、降低画布倍率，每一级都要验证是否见效。
 * 每次绘制都会调用 `sample()`，只做数值运算。
 */

/** 判定窗口：连续这么多帧才评估一次，避免单次卡顿触发调整。 */
const WINDOW = 45
/** 帧很慢时凑满 `WINDOW` 帧要好几秒，窗口改按时间结束：满这么多毫秒且不少于 `WINDOW_MIN` 帧。 */
const WINDOW_MS = 1000
const WINDOW_MIN = 12
/** 间隔超过它视为绘制中断（页面静止或标签页在后台），丢弃当前窗口。 */
const IDLE_GAP = 120
/** 平均间隔超过它（约 51 帧）时降一级。 */
const SLOW_INTERVAL = 19.5
/** 平均间隔低于它（约 57 帧）时视为流畅。 */
const FAST_INTERVAL = 17.5
/** 每级把着色像素数减少约四成。级差太小时省下的着色抵不过多出的一遍离屏绘制。 */
const STEP = 0.75
const MIN_SCALE = 0.5
/**
 * 画布倍率每级把像素数乘以多少。文字随之变软，所以级差比玻璃着色小：缺省减少四分之一；
 * 间隔超出很多时按“开销与像素数成正比”估计需要的比例，一级最多减半，免得连续重建好几次画布。
 */
const CANVAS_PIXELS = 0.75
const CANVAS_PIXELS_MIN = 0.5
/** 升回画布倍率时每级的系数。 */
const CANVAS_STEP = Math.sqrt(CANVAS_PIXELS)
/** 流畅多久后尝试升回，单位毫秒；升回后再次变慢则加倍。 */
const RETRY_DELAY = 4000
const RETRY_DELAY_MAX = 64000
/** 连续这么多个窗口都变慢才降级。短暂的布局动画只会拖慢一个窗口，不应改变分辨率。 */
const SLOW_WINDOWS = 2
/** 调整后忽略的帧数。重新分配绘制目标本身会造成一两帧卡顿，不应计入下一次判定。 */
const SETTLE_FRAMES = 10
/** 升回后需要连续这么多个窗口不变慢，才认为这一级可以维持。 */
const PROBATION_WINDOWS = 4
/**
 * 降一级后平均间隔至少要缩短这么多毫秒、且不少于原来的这个比例才算见效，否则撤回这一级。
 * 间隔很长时窗口之间的波动就有几毫秒，只看绝对值会把噪声当成见效。
 */
const GAIN_MIN = 1
const GAIN_RATIO = 0.05
/** 一种手段无效后跳过它多久，单位毫秒；再次无效则加倍。 */
const SKIP_DELAY = 30000
const SKIP_DELAY_MAX = 240000

/** 降级的手段，按损失从小到大排列。 */
const NONE = -1
const OPTICS = 0
const GLASS = 1
const CANVAS = 2
const MEANS = 3

/**
 * 根据连续绘制的间隔调整渲染质量。
 *
 * 绘制由浏览器按显示器刷新驱动，间隔只能说明“是否跟得上”，不能说明还有多少余量，也不能说明慢在哪里。
 * 因此持续变慢时降一级，再用下一个窗口检验：间隔没有缩短就撤回这一级、在一段时间内跳过这种手段，
 * 直接换下一种；见效但仍然偏慢就继续降。流畅一段时间后试着升一级，如果升回后不久又变慢，
 * 就撤回这次升级并把下次尝试推后一倍。
 *
 * 手段按损失从小到大排列：光路不是剖面查表时先改用查表（只有融合连接处与裁剪边变成近似，清晰度不变）；
 * 然后逐级降低玻璃着色倍率（所有玻璃的轮廓与高光变软）；最后逐级降低画布倍率（整页文字变软，
 * 但瓶颈是画布像素数时只有它有效）。升回时顺序相反。
 *
 * 检验跨越绘制中断：降级后页面静止再恢复绘制时，仍用中断前的间隔作基准。
 */
export class AdaptiveScale {
  /** 玻璃着色倍率的系数。 */
  scale = 1
  /** 光路是否已降为剖面查表。 */
  relaxed = false
  /** 画布倍率的系数，不低于 `setCanvasFloor()` 给出的下限。 */
  canvasScale = 1
  /** 光路能否降级：配置的光路不是剖面查表时由舞台设为 true。 */
  private relaxable = false
  /** 画布倍率系数的下限；1 表示不允许降低画布倍率。 */
  private canvasFloor = 1
  private last = 0
  private total = 0
  private count = 0
  private settle = 0
  private slowWindows = 0
  private retryDelay = RETRY_DELAY
  private fastSince = 0
  /** 升回后剩余的观察窗口数，大于零时再次变慢视为升回失败。 */
  private probation = 0
  /** 最近一次升回的手段，升回失败时撤回它。 */
  private raised = NONE
  /** 正在检验是否见效的手段。 */
  private trial = NONE
  /** 这一级生效前的平均间隔。 */
  private trialBefore = 0
  /** 这一级生效前的系数，撤回时恢复。 */
  private trialPrevious = 1
  /** 各手段在这个时间之前不再尝试。 */
  private readonly skipUntil = new Float64Array(MEANS)
  private readonly skipDelay = new Float64Array(MEANS).fill(SKIP_DELAY)

  /** 恢复到不降级的初始状态。 */
  reset(): void {
    this.scale = 1
    this.relaxed = false
    this.canvasScale = 1
    this.last = 0
    this.total = 0
    this.count = 0
    this.settle = 0
    this.slowWindows = 0
    this.retryDelay = RETRY_DELAY
    this.fastSince = 0
    this.probation = 0
    this.raised = NONE
    this.trial = NONE
    this.skipUntil.fill(0)
    this.skipDelay.fill(SKIP_DELAY)
  }

  /** 设置光路能否降级。不能降级时撤销已有的光路降级，其余不变。 */
  setRelaxable(relaxable: boolean): void {
    this.relaxable = relaxable
    if (relaxable)
      return
    this.relaxed = false
    if (this.trial === OPTICS)
      this.trial = NONE
  }

  /** 设置画布倍率系数的下限（0 到 1），1 表示不允许降低画布倍率。已经低于下限的系数会被抬到下限。 */
  setCanvasFloor(floor: number): void {
    this.canvasFloor = floor > 0 && floor < 1
      ? floor
      : 1
    if (this.canvasScale < this.canvasFloor)
      this.canvasScale = this.canvasFloor
  }

  /** 记录一次绘制的时间戳（毫秒）。光路或任一系数发生变化时返回 true。 */
  sample(now: number): boolean {
    const interval = now - this.last
    this.last = now
    if (interval <= 0 || interval > IDLE_GAP) {
      this.total = 0
      this.count = 0
      this.slowWindows = 0
      this.fastSince = 0
      return false
    }
    if (this.settle > 0) {
      this.settle--
      return false
    }
    this.total += interval
    this.count++
    if (this.count < WINDOW && (this.total < WINDOW_MS || this.count < WINDOW_MIN))
      return false
    const mean = this.total / this.count
    this.total = 0
    this.count = 0

    const trial = this.trial
    if (trial !== NONE) {
      this.trial = NONE
      if (this.trialBefore - mean < Math.max(GAIN_MIN, this.trialBefore * GAIN_RATIO)) {
        // 没有见效：撤回这一级，暂时跳过这种手段；仍然偏慢时直接换下一种，基准仍是这一级之前的间隔。
        this.restore(trial)
        this.skipUntil[trial] = now + this.skipDelay[trial]!
        this.skipDelay[trial] = Math.min(this.skipDelay[trial]! * 2, SKIP_DELAY_MAX)
        if (mean > SLOW_INTERVAL)
          this.lower(this.next(now), this.trialBefore)
        return true
      }
      this.skipDelay[trial] = SKIP_DELAY
      // 见效但仍然偏慢：不必再等两个窗口，接着降。
      if (mean > SLOW_INTERVAL)
        return this.lower(this.next(now), mean)
    }

    if (mean > SLOW_INTERVAL) {
      this.fastSince = 0
      if (++this.slowWindows < SLOW_WINDOWS)
        return false
      this.slowWindows = 0
      let means = NONE
      if (this.probation > 0) {
        // 升回后不久又变慢：推迟下一次尝试，并撤回刚升的那一级。
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_DELAY_MAX)
        if (this.available(this.raised))
          means = this.raised
      }
      this.probation = 0
      if (means === NONE)
        means = this.next(now)
      return this.lower(means, mean)
    }
    this.slowWindows = 0
    if (this.probation > 0 && --this.probation === 0)
      this.retryDelay = RETRY_DELAY
    if (mean < FAST_INTERVAL && (this.canvasScale < 1 || this.scale < 1 || this.relaxed)) {
      this.fastSince ||= now
      if (now - this.fastSince < this.retryDelay)
        return false
      this.fastSince = 0
      this.probation = PROBATION_WINDOWS
      this.settle = SETTLE_FRAMES
      if (this.canvasScale < 1) {
        this.canvasScale = snap(Math.min(1, this.canvasScale / CANVAS_STEP), CANVAS_STEP)
        this.raised = CANVAS
      }
      else if (this.scale < 1) {
        this.scale = snap(Math.min(1, this.scale / STEP), STEP)
        this.raised = GLASS
      }
      else {
        this.relaxed = false
        this.raised = OPTICS
      }
      return true
    }
    this.fastSince = 0
    return false
  }

  /** 这种手段是否还有可降的一级。 */
  private available(means: number): boolean {
    if (means === OPTICS)
      return this.relaxable && !this.relaxed
    if (means === GLASS)
      return this.scale > MIN_SCALE + 0.001
    if (means === CANVAS)
      return this.canvasScale > this.canvasFloor + 0.001
    return false
  }

  /** 按损失从小到大找出下一种可用且没有被跳过的手段。 */
  private next(now: number): number {
    for (let means = OPTICS; means < MEANS; means++) {
      if (now >= this.skipUntil[means]! && this.available(means))
        return means
    }
    return NONE
  }

  /** 把一种手段降一级并开始检验，`before` 是这一级之前的平均间隔。没有可用的手段时返回 false。 */
  private lower(means: number, before: number): boolean {
    if (means === NONE)
      return false
    if (means === OPTICS) {
      this.relaxed = true
    }
    else if (means === GLASS) {
      this.trialPrevious = this.scale
      this.scale = Math.max(MIN_SCALE, this.scale * STEP)
    }
    else {
      this.trialPrevious = this.canvasScale
      const pixels = Math.min(CANVAS_PIXELS, Math.max(CANVAS_PIXELS_MIN, FAST_INTERVAL / before))
      this.canvasScale = Math.max(this.canvasFloor, this.canvasScale * Math.sqrt(pixels))
    }
    this.trial = means
    this.trialBefore = before
    this.settle = SETTLE_FRAMES
    this.slowWindows = 0
    this.fastSince = 0
    return true
  }

  /** 撤回刚降的一级。 */
  private restore(means: number): void {
    if (means === OPTICS)
      this.relaxed = false
    else if (means === GLASS)
      this.scale = this.trialPrevious
    else
      this.canvasScale = this.trialPrevious
    this.settle = SETTLE_FRAMES
  }
}

/** 距离 1 不足半级时直接回到 1，避免停在 0.99 这样的系数上。 */
function snap(value: number, step: number): number {
  return value > 1 - (1 - step) / 2
    ? 1
    : value
}
