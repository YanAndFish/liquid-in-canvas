interface VideoTrack {
  handle: number
  readonly onFrame: () => void
}

export class VideoClock {
  private readonly onFrame: () => void
  private root: HTMLElement | null = null
  private readonly tracks = new Map<HTMLVideoElement, VideoTrack>()
  private readonly polled = new Set<HTMLVideoElement>()
  private pollFrame: number | null = null

  constructor(onFrame: () => void) {
    this.onFrame = onFrame
  }

  attach(root: HTMLElement): void {
    this.detach()
    this.root = root
    root.addEventListener('play', this.handlePlay, true)
    root.addEventListener('seeked', this.handleSeeked, true)
    for (const video of root.querySelectorAll('video')) {
      if (!video.paused && !video.ended)
        this.watch(video)
    }
  }

  detach(): void {
    const root = this.root
    if (!root)
      return
    root.removeEventListener('play', this.handlePlay, true)
    root.removeEventListener('seeked', this.handleSeeked, true)
    for (const video of this.tracks.keys())
      this.unwatch(video)
    for (const video of this.polled)
      this.unwatch(video)
    this.root = null
  }

  private readonly handlePlay = (event: Event): void => {
    this.prune()
    if (event.target instanceof HTMLVideoElement)
      this.watch(event.target)
  }

  private readonly handleStop = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement))
      return
    this.unwatch(event.target)
    this.onFrame()
  }

  private readonly handleSeeked = (): void => {
    this.onFrame()
  }

  private watch(video: HTMLVideoElement): void {
    if (this.tracks.has(video) || this.polled.has(video))
      return
    video.addEventListener('pause', this.handleStop)
    video.addEventListener('ended', this.handleStop)
    if (typeof video.requestVideoFrameCallback !== 'function') {
      this.polled.add(video)
      this.pollFrame ??= requestAnimationFrame(this.poll)
      return
    }
    const track: VideoTrack = {
      handle: 0,
      onFrame: () => {
        if (!this.playing(video)) {
          this.unwatch(video)
          return
        }
        this.onFrame()
        track.handle = video.requestVideoFrameCallback(track.onFrame)
      },
    }
    track.handle = video.requestVideoFrameCallback(track.onFrame)
    this.tracks.set(video, track)
  }

  private unwatch(video: HTMLVideoElement): void {
    video.removeEventListener('pause', this.handleStop)
    video.removeEventListener('ended', this.handleStop)
    const track = this.tracks.get(video)
    if (track) {
      video.cancelVideoFrameCallback(track.handle)
      this.tracks.delete(video)
    }
    this.polled.delete(video)
    if (!this.polled.size && this.pollFrame !== null) {
      cancelAnimationFrame(this.pollFrame)
      this.pollFrame = null
    }
  }

  private playing(video: HTMLVideoElement): boolean {
    return !video.paused && !video.ended && !!this.root?.contains(video)
  }

  private prune(): void {
    for (const video of this.tracks.keys()) {
      if (!this.playing(video))
        this.unwatch(video)
    }
    for (const video of this.polled) {
      if (!this.playing(video))
        this.unwatch(video)
    }
  }

  private readonly poll = (): void => {
    this.pollFrame = null
    this.prune()
    if (!this.polled.size)
      return
    this.onFrame()
    this.pollFrame = requestAnimationFrame(this.poll)
  }
}
