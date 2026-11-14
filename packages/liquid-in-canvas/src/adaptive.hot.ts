/**
 * 玻璃着色倍率的自适应缩放。每次绘制都会调用 `sample()`，只做数值运算。
 */

/** 判定窗口：连续这么多帧才评估一次，避免单次卡顿触发调整。 */
const WINDOW = 45
/** 间隔超过它视为绘制中断（页面静止或标签页在后台），丢弃当前窗口。 */
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
 * 根据连续绘制的间隔调整玻璃着色的缩放。
 *
 * 绘制由浏览器按显示器刷新驱动，间隔只能说明“是否跟得上”，不能说明还有多少余量。
 * 因此持续变慢时降一级；流畅一段时间后试着升一级，如果升回后不久又变慢，就把下次尝试推后一倍。
 */
export class AdaptiveScale {
  scale = 1
  private last = 0
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
    this.last = 0
    this.total = 0
    this.count = 0
    this.settle = 0
    this.slowWindows = 0
    this.retryDelay = RETRY_DELAY
    this.fastSince = 0
    this.probation = 0
  }

  /** 记录一次绘制的时间戳（毫秒）。缩放发生变化时返回 true。 */
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
      return this.apply(Math.max(MIN_SCALE, this.scale * STEP))
    }
    this.slowWindows = 0
    if (this.probation > 0 && --this.probation === 0)
      this.retryDelay = RETRY_DELAY
    if (mean < FAST_INTERVAL && this.scale < 1) {
      this.fastSince ||= now
      if (now - this.fastSince >= this.retryDelay) {
        this.fastSince = 0
        this.probation = PROBATION_WINDOWS
        return this.apply(Math.min(1, this.scale / STEP))
      }
      return false
    }
    this.fastSince = 0
    return false
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
