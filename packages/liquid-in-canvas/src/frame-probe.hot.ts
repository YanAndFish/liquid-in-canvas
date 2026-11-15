/**
 * 判断一次绘制是不是紧接着上一次绘制所在的显示帧。每次绘制调用一次 `mark()`，只做数值运算。
 *
 * 绘制由浏览器的 `paint` 事件驱动，页面没有变化的显示帧不会绘制。两次绘制相隔 33 ms 可能是
 * 跟不上显示器（中间那一帧没画出来），也可能是中间那一帧本来就没有东西要画（30 帧的视频、
 * 间歇的 DOM 更新）。区别在于后者中间有一个没有绘制的显示帧：每次绘制之后用
 * `requestAnimationFrame` 数最多两个显示帧，下一次绘制到来时不足两个，说明它没有被空过。
 *
 * 绘制停止后回调数到两帧也随之停止，静止的页面没有常驻的循环。
 */
export class FrameProbe {
  /** 上一次绘制之后经过的显示帧数，数到 2 为止。 */
  private frames = 0
  private handle = 0

  /** 记录一次绘制。上一次绘制之后没有空出显示帧时返回 true。 */
  mark(): boolean {
    const continuous = this.frames < 2
    this.frames = 0
    if (!this.handle)
      this.handle = requestAnimationFrame(this.tick)
    return continuous
  }

  /** 停止计数，之后的第一次绘制不算连续。 */
  stop(): void {
    if (this.handle)
      cancelAnimationFrame(this.handle)
    this.handle = 0
    this.frames = 2
  }

  private readonly tick = (): void => {
    // 绘制与回调在同一帧里的先后不影响结果：无论谁先，隔了一帧的绘制到来时都已数到 2。
    this.handle = ++this.frames < 2
      ? requestAnimationFrame(this.tick)
      : 0
  }
}
