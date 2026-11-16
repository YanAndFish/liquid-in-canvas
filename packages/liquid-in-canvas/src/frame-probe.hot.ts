export class FrameProbe {
  private frames = 0
  private handle = 0

  mark(): boolean {
    const continuous = this.frames < 2
    this.frames = 0
    if (!this.handle)
      this.handle = requestAnimationFrame(this.tick)
    return continuous
  }

  stop(): void {
    if (this.handle)
      cancelAnimationFrame(this.handle)
    this.handle = 0
    this.frames = 2
  }

  private readonly tick = (): void => {
    this.handle = ++this.frames < 2
      ? requestAnimationFrame(this.tick)
      : 0
  }
}
