/**
 * 玻璃着色的自适应降级：先把光路降为查表，再降低着色倍率。每次绘制都会调用 `sample()`，只做数值运算。
 */

/** 判定窗口：连续这么多帧才评估一次，避免单次卡顿触发调整。 */
const WINDOW = 45
/** 间隔超过它视为绘制中断（页面静止或标签页在后台），丢弃当前窗口；这么久没有连续的绘制也一样。 */
const IDLE_GAP = 120
/** 平均间隔超过它（约 51 帧）时降一级。 */
const SLOW_INTERVAL = 19.5
/** 平均间隔低于它（约 57 帧）时视为流畅。 */
const FAST_INTERVAL = 17.5
/** 每级把着色像素数减少约四成。级差太小时省下的着色抵不过多出的一遍离屏绘制。 */
const STEP = 0.75
const MIN_SCALE = 0.5
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
 * 根据连续绘制的间隔调整玻璃着色的质量。
 *
 * 绘制由浏览器按显示器刷新驱动，间隔只能说明“是否跟得上”，不能说明还有多少余量。
 * 因此持续变慢时降一级；流畅一段时间后试着升一级，如果升回后不久又变慢，就把下次尝试推后一倍。
 *
 * 只有紧接着上一个显示帧的绘制才取样（`FrameProbe`）。中间空过显示帧的绘制是页面按自己的节拍在更新，
 * 例如只有 30 帧的视频在驱动重绘：间隔是 33 ms，却不是掉帧。这样的绘制不改变质量，既不降级也不升回。
 *
 * 降级按损失从小到大排列：光路不是剖面查表时，第一级先改用查表（只有融合连接处与裁剪边变成近似，
 * 清晰度不变）；之后才逐级降低着色倍率（所有玻璃的轮廓与高光变软）。升回时顺序相反。
 */
export class AdaptiveScale {
  scale = 1
  /** 光路是否已降为剖面查表。 */
  relaxed = false
  /** 光路能否降级：配置的光路不是剖面查表时由舞台设为 true。 */
  private relaxable = false
  private last = 0
  /** 上一次连续绘制的时间戳。 */
  private sampled = 0
  private total = 0
  private count = 0
  private settle = 0
  private slowWindows = 0
  private retryDelay = RETRY_DELAY
  private fastSince = 0
  /** 升回后剩余的观察窗口数，大于零时再次变慢视为升回失败。 */
  private probation = 0

  /** 恢复到不缩放的初始状态。 */
  reset(): void {
    this.scale = 1
    this.relaxed = false
    this.last = 0
    this.sampled = 0
    this.total = 0
    this.count = 0
    this.settle = 0
    this.slowWindows = 0
    this.retryDelay = RETRY_DELAY
    this.fastSince = 0
    this.probation = 0
  }

  /** 设置光路能否降级。不能降级时撤销已有的光路降级，着色倍率不变。 */
  setRelaxable(relaxable: boolean): void {
    this.relaxable = relaxable
    if (!relaxable)
      this.relaxed = false
  }

  /**
   * 记录一次绘制的时间戳（毫秒）。光路或缩放发生变化时返回 true。
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
    if (++this.count < WINDOW)
      return false
    const mean = this.total / this.count
    this.total = 0
    this.count = 0

    if (mean > SLOW_INTERVAL) {
      this.fastSince = 0
      if (++this.slowWindows < SLOW_WINDOWS)
        return false
      this.slowWindows = 0
      if (this.probation > 0)
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_DELAY_MAX)
      this.probation = 0
      if (this.relaxable && !this.relaxed) {
        this.relaxed = true
        this.settle = SETTLE_FRAMES
        return true
      }
      return this.apply(Math.max(MIN_SCALE, this.scale * STEP))
    }
    this.slowWindows = 0
    if (this.probation > 0 && --this.probation === 0)
      this.retryDelay = RETRY_DELAY
    if (mean < FAST_INTERVAL && (this.scale < 1 || this.relaxed)) {
      this.fastSince ||= now
      if (now - this.fastSince >= this.retryDelay) {
        this.fastSince = 0
        this.probation = PROBATION_WINDOWS
        if (this.scale < 1)
          return this.apply(Math.min(1, this.scale / STEP))
        this.relaxed = false
        this.settle = SETTLE_FRAMES
        return true
      }
      return false
    }
    this.fastSince = 0
    return false
  }

  /** 绘制中断：丢弃当前窗口与连续变慢、连续流畅的计数，已有的降级保持不变。 */
  private interrupt(): void {
    this.total = 0
    this.count = 0
    this.slowWindows = 0
    this.fastSince = 0
  }

  private apply(next: number): boolean {
    // 距离 1 不足半级时直接回到 1，避免停在 0.99 这样的倍率上。
    const snapped = next > 1 - (1 - STEP) / 2
      ? 1
      : next
    if (Math.abs(snapped - this.scale) < 0.001)
      return false
    this.scale = snapped
    this.settle = SETTLE_FRAMES
    return true
  }
}
