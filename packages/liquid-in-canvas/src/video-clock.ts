/** 一个用视频帧回调跟踪的视频。 */
interface VideoTrack {
  /** 已登记、尚未触发的回调句柄。 */
  handle: number
  /** 这个视频的帧回调，每次触发后重新登记。 */
  readonly onFrame: () => void
}

/**
 * 画布舞台的视频时钟：根元素里有视频在播放时，每出现一个新的视频帧请求一次重绘。
 *
 * 视频帧的节拍来自 `HTMLVideoElement.requestVideoFrameCallback()`：30 帧的视频在 60 Hz 的屏幕上
 * 每两个显示帧才有一个新画面，逐显示帧重绘会把同一帧视频画两遍。视频滚出视口后浏览器不再回调，
 * 也就不再重绘。浏览器没有这个接口时退回逐显示帧请求重绘。
 */
export class VideoClock {
  private readonly onFrame: () => void
  private root: HTMLElement | null = null
  /** 用视频帧回调跟踪的视频。 */
  private readonly tracks = new Map<HTMLVideoElement, VideoTrack>()
  /** 没有视频帧回调时逐显示帧轮询的视频。 */
  private readonly polled = new Set<HTMLVideoElement>()
  private pollFrame: number | null = null

  /** `onFrame` 在需要重绘时调用：出现新的视频帧、停止播放、跳转完成。 */
  constructor(onFrame: () => void) {
    this.onFrame = onFrame
  }

  /** 开始跟踪 `root` 里的视频，已经在播放的立即登记。 */
  attach(root: HTMLElement): void {
    this.detach()
    this.root = root
    // 媒体事件不冒泡，在捕获阶段监听才能发现之后加入的视频。
    root.addEventListener('play', this.handlePlay, true)
    root.addEventListener('seeked', this.handleSeeked, true)
    for (const video of root.querySelectorAll('video')) {
      if (!video.paused && !video.ended)
        this.watch(video)
    }
  }

  /** 停止跟踪，取消所有尚未触发的回调。 */
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
    // 借这个机会清掉没有收到停止事件的视频，例如连同祖先一起被移出文档、又没有触发 `pause` 的。
    this.prune()
    if (event.target instanceof HTMLVideoElement)
      this.watch(event.target)
  }

  /** 暂停、播放结束，或播放中被移出文档（浏览器随后在元素上触发 `pause`）。 */
  private readonly handleStop = (event: Event): void => {
    if (!(event.target instanceof HTMLVideoElement))
      return
    this.unwatch(event.target)
    // 停止前的最后一帧可能还没有回调过，补一次重绘。
    this.onFrame()
  }

  private readonly handleSeeked = (): void => {
    this.onFrame()
  }

  private watch(video: HTMLVideoElement): void {
    if (this.tracks.has(video) || this.polled.has(video))
      return
    // 直接监听元素：被移出文档的视频收到的 `pause` 不会经过根元素。
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

  /** 视频是否还在根元素里播放。 */
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

  /** 回退：没有视频帧回调时，有视频在播放就逐显示帧请求重绘。 */
  private readonly poll = (): void => {
    this.pollFrame = null
    this.prune()
    if (!this.polled.size)
      return
    this.onFrame()
    this.pollFrame = requestAnimationFrame(this.poll)
  }
}
