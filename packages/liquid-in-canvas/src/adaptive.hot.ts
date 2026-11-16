/**
 * 自适应降级：依次尝试把光路降为查表、降低玻璃着色倍率、降低画布倍率，每一级都要验证是否见效。
 * 每次绘制都会调用 `sample()`，只做数值运算。
 */

/** 判定窗口：连续这么多帧才评估一次，避免单次卡顿触发调整。 */
const WINDOW = 45
/** 帧很慢时凑满 `WINDOW` 帧要好几秒，窗口改按时间结束：满这么多毫秒且不少于 `WINDOW_MIN` 帧。 */
const WINDOW_MS = 1000
const WINDOW_MIN = 12
/** 间隔超过它视为绘制中断（页面静止或标签页在后台），丢弃当前窗口；这么久没有连续的绘制也一样。 */
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
/**
 * 升回后的观察期，单位毫秒。期间再次变慢就撤回这次升级；维持这么久才把升回的等待时间恢复为初值。
 * 要长于常见的滚动往返，否则画面里贵的一段每次滚到都会触发一次升回、撤回。
 */
const PROBATION_MS = 20000
/**
 * 降一级后平均间隔至少要缩短这么多毫秒、且不少于原来的这个比例才算见效，否则撤回这一级。
 * 间隔很长时窗口之间的波动就有几毫秒，只看绝对值会把噪声当成见效。
 */
const GAIN_MIN = 1
const GAIN_RATIO = 0.05
/** 降级后要连续这么多个窗口都见效才保留。帧间隔按刷新周期量化，单个窗口的均值会因几帧卡顿偏离好几毫秒。 */
const TRIAL_WINDOWS = 2
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
 * 因此持续变慢时降一级，再用随后的窗口检验：与降级前两个窗口中较快的一个相比，间隔没有缩短就撤回这一级、
 * 在一段时间内跳过这种手段，直接换下一种；见效但仍然偏慢就继续降。
 * 流畅一段时间后试着升一级，如果升回后不久又变慢，就回到升回前的状态并把下次尝试推后一倍。
 *
 * 手段按损失从小到大排列：光路不是剖面查表时先改用查表（只有融合连接处与裁剪边变成近似，清晰度不变）；
 * 然后逐级降低玻璃着色倍率（所有玻璃的轮廓与高光变软）；最后逐级降低画布倍率（整页文字变软，
 * 但瓶颈是画布像素数时只有它有效）。升回时顺序相反。
 *
 * 检验跨越绘制中断：降级后页面静止再恢复绘制时，仍用中断前的间隔作基准。
 *
 * 只有紧接着上一个显示帧的绘制才取样（`FrameProbe`）。中间空过显示帧的绘制是页面按自己的节拍在更新，
 * 例如只有 30 帧的视频在驱动重绘：间隔是 33 ms，却不是掉帧。这样的绘制不计入窗口，既不降级、不升回，
 * 也不推进正在进行的检验，与绘制中断一样处理。
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
  /** 上一次连续绘制的时间戳。 */
  private sampled = 0
  private total = 0
  private count = 0
  private settle = 0
  private slowWindows = 0
  /** 连续变慢的各窗口里最小的均值，降级时作为基准。偶尔一个窗口里有卡顿，不应抬高基准。 */
  private slowMin = Infinity
  private retryDelay = RETRY_DELAY
  private fastSince = 0
  /** 观察期内最近一次升回的手段，升回失败时撤回它；观察期结束后为 `NONE`。 */
  private raised = NONE
  /** 升回前的系数，升回失败时直接恢复。 */
  private raisedFrom = 1
  /** 最近一次升回的时间。 */
  private raisedAt = 0
  /** 正在检验是否见效的手段。 */
  private trial = NONE
  /** 这一级生效前的平均间隔。 */
  private trialBefore = 0
  /** 这一级生效前的系数，撤回时恢复。 */
  private trialPrevious = 1
  /** 这一级已经通过检验的窗口数与其中最小的均值。 */
  private trialWindows = 0
  private trialMin = Infinity
  /** 各手段在这个时间之前不再尝试。 */
  private readonly skipUntil = new Float64Array(MEANS)
  private readonly skipDelay = new Float64Array(MEANS).fill(SKIP_DELAY)

  /** 恢复到不降级的初始状态。 */
  reset(): void {
    this.scale = 1
    this.relaxed = false
    this.canvasScale = 1
    this.last = 0
    this.sampled = 0
    this.total = 0
    this.count = 0
    this.settle = 0
    this.slowWindows = 0
    this.slowMin = Infinity
    this.retryDelay = RETRY_DELAY
    this.fastSince = 0
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

  /**
   * 记录一次绘制的时间戳（毫秒）。光路或任一系数发生变化时返回 true。
   *
   * `continuous` 表示这次绘制紧接着上一次绘制所在的显示帧，只有这样的间隔才说明跟不跟得上显示器。
   */
  sample(now: number, continuous = true): boolean {
    const interval = now - this.last
    this.last = now
    if (!continuous) {
      // 夹在连续绘制之间的零星空帧只跳过这一次；一直没有连续的绘制时，之前攒下的窗口已经过时。
      if (now - this.sampled > IDLE_GAP)
        this.interrupt()
      return false
    }
    this.sampled = now
    if (interval <= 0 || interval > IDLE_GAP) {
      this.interrupt()
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

    // 升回后维持了一段时间：这一级站稳了，之后再变慢按新的瓶颈处理。
    if (this.raised !== NONE && now - this.raisedAt >= PROBATION_MS) {
      this.raised = NONE
      this.retryDelay = RETRY_DELAY
    }

    const trial = this.trial
    if (trial !== NONE) {
      const before = this.trialBefore
      if (before - mean < Math.max(GAIN_MIN, before * GAIN_RATIO)) {
        // 没有见效：撤回这一级，暂时跳过这种手段；仍然偏慢时直接换下一种，基准仍是这一级之前的间隔。
        this.trial = NONE
        this.restore(trial)
        this.skipUntil[trial] = now + this.skipDelay[trial]!
        this.skipDelay[trial] = Math.min(this.skipDelay[trial]! * 2, SKIP_DELAY_MAX)
        if (mean > SLOW_INTERVAL)
          this.lower(this.next(now), before)
        return true
      }
      this.trialMin = Math.min(this.trialMin, mean)
      if (++this.trialWindows < TRIAL_WINDOWS)
        return false
      this.trial = NONE
      this.skipDelay[trial] = SKIP_DELAY
      // 见效但仍然偏慢：不必再等两个窗口，以检验期间较快的窗口为基准接着降。
      if (this.trialMin > SLOW_INTERVAL)
        return this.lower(this.next(now), this.trialMin)
    }

    if (mean > SLOW_INTERVAL) {
      this.fastSince = 0
      this.slowMin = Math.min(this.slowMin, mean)
      if (++this.slowWindows < SLOW_WINDOWS)
        return false
      const before = this.slowMin
      this.slowWindows = 0
      this.slowMin = Infinity
      if (this.raised !== NONE) {
        // 升回后不久又变慢：推迟下一次尝试，直接回到升回前的状态。那一级之前检验过，不必再检验。
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_DELAY_MAX)
        if (this.unraise())
          return true
      }
      return this.lower(this.next(now), before)
    }
    this.slowWindows = 0
    this.slowMin = Infinity
    if (mean < FAST_INTERVAL && (this.canvasScale < 1 || this.scale < 1 || this.relaxed)) {
      this.fastSince ||= now
      if (now - this.fastSince < this.retryDelay)
        return false
      this.fastSince = 0
      this.raisedAt = now
      this.settle = SETTLE_FRAMES
      if (this.canvasScale < 1) {
        this.raisedFrom = this.canvasScale
        this.canvasScale = snap(Math.min(1, this.canvasScale / CANVAS_STEP), CANVAS_STEP)
        this.raised = CANVAS
      }
      else if (this.scale < 1) {
        this.raisedFrom = this.scale
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

  /** 绘制中断：丢弃当前窗口与连续变慢、连续流畅的计数。已有的降级与正在进行的检验保持不变。 */
  private interrupt(): void {
    this.total = 0
    this.count = 0
    this.slowWindows = 0
    this.slowMin = Infinity
    this.fastSince = 0
  }

  /** 撤回最近一次升回。升回的手段已经失效（例如光路改为不能降级）时返回 false。 */
  private unraise(): boolean {
    const raised = this.raised
    this.raised = NONE
    if (raised === OPTICS) {
      if (!this.relaxable || this.relaxed)
        return false
      this.relaxed = true
    }
    else if (raised === GLASS) {
      this.scale = Math.min(this.scale, this.raisedFrom)
    }
    else if (raised === CANVAS) {
      this.canvasScale = Math.min(this.canvasScale, Math.max(this.canvasFloor, this.raisedFrom))
    }
    else {
      return false
    }
    this.settle = SETTLE_FRAMES
    this.fastSince = 0
    return true
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
    this.trialWindows = 0
    this.trialMin = Infinity
    this.settle = SETTLE_FRAMES
    this.slowWindows = 0
    this.slowMin = Infinity
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
