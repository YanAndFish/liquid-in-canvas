const WINDOW = 45
const WINDOW_MS = 1000
const WINDOW_MIN = 12
const IDLE_GAP = 120
const SLOW_INTERVAL = 19.5
const FAST_INTERVAL = 17.5
const STEP = 0.75
const MIN_SCALE = 0.5
const CANVAS_PIXELS = 0.75
const CANVAS_PIXELS_MIN = 0.5
const CANVAS_STEP = Math.sqrt(CANVAS_PIXELS)
const RETRY_DELAY = 4000
const RETRY_DELAY_MAX = 64000
const SLOW_WINDOWS = 2
const SETTLE_FRAMES = 10
const PROBATION_MS = 20000
const GAIN_MIN = 1
const GAIN_RATIO = 0.05
const TRIAL_WINDOWS = 2
const SKIP_DELAY = 30000
const SKIP_DELAY_MAX = 240000

const NONE = -1
const OPTICS = 0
const GLASS = 1
const CANVAS = 2
const MEANS = 3

export class AdaptiveScale {
  scale = 1
  relaxed = false
  canvasScale = 1
  private relaxable = false
  private canvasFloor = 1
  private last = 0
  private sampled = 0
  private total = 0
  private count = 0
  private settle = 0
  private slowWindows = 0
  private slowMin = Infinity
  private retryDelay = RETRY_DELAY
  private fastSince = 0
  private raised = NONE
  private raisedFrom = 1
  private raisedAt = 0
  private trial = NONE
  private trialBefore = 0
  private trialPrevious = 1
  private trialWindows = 0
  private trialMin = Infinity
  private readonly skipUntil = new Float64Array(MEANS)
  private readonly skipDelay = new Float64Array(MEANS).fill(SKIP_DELAY)

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

  setRelaxable(relaxable: boolean): void {
    this.relaxable = relaxable
    if (relaxable)
      return
    this.relaxed = false
    if (this.trial === OPTICS)
      this.trial = NONE
  }

  setCanvasFloor(floor: number): void {
    this.canvasFloor = floor > 0 && floor < 1
      ? floor
      : 1
    if (this.canvasScale < this.canvasFloor)
      this.canvasScale = this.canvasFloor
  }

  sample(now: number, continuous = true): boolean {
    const interval = now - this.last
    this.last = now
    if (!continuous) {
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

    if (this.raised !== NONE && now - this.raisedAt >= PROBATION_MS) {
      this.raised = NONE
      this.retryDelay = RETRY_DELAY
    }

    const trial = this.trial
    if (trial !== NONE) {
      const before = this.trialBefore
      if (before - mean < Math.max(GAIN_MIN, before * GAIN_RATIO)) {
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

  private interrupt(): void {
    this.total = 0
    this.count = 0
    this.slowWindows = 0
    this.slowMin = Infinity
    this.fastSince = 0
  }

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

  private available(means: number): boolean {
    if (means === OPTICS)
      return this.relaxable && !this.relaxed
    if (means === GLASS)
      return this.scale > MIN_SCALE + 0.001
    if (means === CANVAS)
      return this.canvasScale > this.canvasFloor + 0.001
    return false
  }

  private next(now: number): number {
    for (let means = OPTICS; means < MEANS; means++) {
      if (now >= this.skipUntil[means]! && this.available(means))
        return means
    }
    return NONE
  }

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

function snap(value: number, step: number): number {
  return value > 1 - (1 - step) / 2
    ? 1
    : value
}
