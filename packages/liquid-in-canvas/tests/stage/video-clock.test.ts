import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoClock } from '../../src/video-clock'

// jsdom 不播放媒体，也没有 `requestVideoFrameCallback`：播放状态与帧回调都在这里模拟。

/** 一个模拟的视频：可以切换播放状态，并手动“呈现”一个视频帧。 */
interface FakeVideo {
  element: HTMLVideoElement
  /** 已登记、尚未触发的帧回调数量。 */
  pending: () => number
  /** 呈现一个新的视频帧：触发并清空已登记的回调。 */
  present: () => void
  request: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

let root: HTMLElement
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function createVideo(options: { playing?: boolean, frameCallback?: boolean } = {}): FakeVideo {
  const element = document.createElement('video')
  Object.defineProperty(element, 'paused', { value: !options.playing, writable: true })
  Object.defineProperty(element, 'ended', { value: false, writable: true })
  const callbacks = new Map<number, VideoFrameRequestCallback>()
  let next = 0
  const request = vi.fn((callback: VideoFrameRequestCallback) => {
    callbacks.set(++next, callback)
    return next
  })
  const cancel = vi.fn((handle: number) => {
    callbacks.delete(handle)
  })
  if (options.frameCallback !== false) {
    element.requestVideoFrameCallback = request
    element.cancelVideoFrameCallback = cancel
  }
  return {
    element,
    pending: () => callbacks.size,
    present: () => {
      const due = Array.from(callbacks.values())
      callbacks.clear()
      for (const callback of due)
        callback(0, {} as VideoFrameCallbackMetadata)
    },
    request,
    cancel,
  }
}

function setState(video: FakeVideo, state: { paused?: boolean, ended?: boolean }): void {
  Object.assign(video.element, state)
}

function play(video: FakeVideo): void {
  setState(video, { paused: false, ended: false })
  video.element.dispatchEvent(new Event('play'))
}

function pause(video: FakeVideo): void {
  setState(video, { paused: true })
  video.element.dispatchEvent(new Event('pause'))
}

/** 推进一个显示帧：触发这之前登记的 `requestAnimationFrame` 回调。 */
function displayFrame(): void {
  const due = Array.from(frames.values())
  frames.clear()
  for (const callback of due)
    callback(0)
}

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle)
  })
})

afterEach(() => {
  root.remove()
  vi.unstubAllGlobals()
})

describe('视频时钟：视频帧回调', () => {
  it('开始跟踪时登记已经在播放的视频，暂停的不登记', () => {
    const playing = createVideo({ playing: true })
    const paused = createVideo()
    root.append(playing.element, paused.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    expect(playing.pending()).toBe(1)
    expect(paused.pending()).toBe(0)
    expect(onFrame).not.toHaveBeenCalled()
    // 不靠显示帧轮询。
    expect(frames.size).toBe(0)
  })

  it('每个新的视频帧请求一次重绘并重新登记', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    for (let i = 1; i <= 5; i++) {
      video.present()
      expect(onFrame).toHaveBeenCalledTimes(i)
      expect(video.pending()).toBe(1)
    }
    // 没有新的视频帧时，显示帧不会带来重绘。
    displayFrame()
    displayFrame()
    expect(onFrame).toHaveBeenCalledTimes(5)
  })

  it('之后开始播放的视频在 play 事件时登记，重复的 play 不会重复登记', () => {
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)
    const video = createVideo()
    // 之后才加入的视频，放在更深的后代里。
    const wrapper = document.createElement('section')
    wrapper.append(video.element)
    root.append(wrapper)

    play(video)
    play(video)
    expect(video.pending()).toBe(1)
    video.present()
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(video.pending()).toBe(1)
  })

  it('多个视频各按自己的帧请求重绘', () => {
    const a = createVideo({ playing: true })
    const b = createVideo({ playing: true })
    root.append(a.element, b.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    a.present()
    a.present()
    b.present()
    expect(onFrame).toHaveBeenCalledTimes(3)
    // 其中一个暂停不影响另一个。
    pause(a)
    onFrame.mockClear()
    expect(a.pending()).toBe(0)
    b.present()
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(b.pending()).toBe(1)
  })

  it('暂停时取消回调，并补一次重绘画出最后一帧', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    pause(video)
    expect(video.cancel).toHaveBeenCalledTimes(1)
    expect(video.pending()).toBe(0)
    expect(onFrame).toHaveBeenCalledTimes(1)
    // 再次播放后重新登记。
    play(video)
    expect(video.pending()).toBe(1)
  })

  it('播放结束时取消回调', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    // 播放到结尾时 `paused` 仍是 false。
    setState(video, { ended: true })
    video.element.dispatchEvent(new Event('ended'))
    expect(video.pending()).toBe(0)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })

  it('循环播放回到开头时继续按视频帧重绘', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    video.present()
    // 回绕时浏览器触发 seeked，没有 pause 或 ended。
    video.element.dispatchEvent(new Event('seeked'))
    video.present()
    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(video.pending()).toBe(1)
  })

  it('暂停状态下跳转完成时重绘一次', () => {
    const video = createVideo()
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    video.element.dispatchEvent(new Event('seeked'))
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(video.pending()).toBe(0)
  })

  it('播放中移出文档：元素上的 pause 取消回调', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    // 浏览器在视频离开文档后暂停它，事件在元素上触发，不经过根元素。
    video.element.remove()
    pause(video)
    expect(video.cancel).toHaveBeenCalledTimes(1)
    expect(video.pending()).toBe(0)
  })

  it('播放中移到根元素之外：下一个视频帧不再重绘，也不再登记', () => {
    const video = createVideo({ playing: true })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    // 仍在文档里播放，但已不属于舞台。
    document.body.append(video.element)
    video.present()
    expect(onFrame).not.toHaveBeenCalled()
    expect(video.pending()).toBe(0)
    video.element.remove()
  })

  it('没有收到停止事件的视频在下一次 play 时清掉', () => {
    const gone = createVideo({ playing: true })
    root.append(gone.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    // 移出文档但没有触发 pause，回调也不会再来。
    gone.element.remove()
    expect(gone.pending()).toBe(1)
    const other = createVideo()
    root.append(other.element)
    play(other)
    expect(gone.pending()).toBe(0)
    expect(other.pending()).toBe(1)
  })

  it('停止跟踪时取消所有回调，之后的事件不再请求重绘', () => {
    const a = createVideo({ playing: true })
    const b = createVideo({ playing: true })
    root.append(a.element, b.element)
    const onFrame = vi.fn()
    const clock = new VideoClock(onFrame)
    clock.attach(root)

    clock.detach()
    expect(a.pending()).toBe(0)
    expect(b.pending()).toBe(0)
    play(a)
    pause(b)
    a.element.dispatchEvent(new Event('seeked'))
    expect(onFrame).not.toHaveBeenCalled()
    expect(a.pending()).toBe(0)
    // 重复调用没有副作用。
    clock.detach()
  })
})

describe('视频时钟：没有视频帧回调时的回退', () => {
  it('有视频在播放时逐显示帧请求重绘', () => {
    const video = createVideo({ playing: true, frameCallback: false })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    expect(frames.size).toBe(1)
    displayFrame()
    displayFrame()
    displayFrame()
    expect(onFrame).toHaveBeenCalledTimes(3)
    expect(frames.size).toBe(1)
  })

  it('多个视频共用一个循环，全部停止后循环结束', () => {
    const a = createVideo({ playing: true, frameCallback: false })
    const b = createVideo({ frameCallback: false })
    root.append(a.element, b.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    play(b)
    expect(frames.size).toBe(1)
    pause(a)
    expect(frames.size).toBe(1)
    pause(b)
    expect(frames.size).toBe(0)
    // 两次暂停各补一次重绘，之后没有逐帧的重绘。
    expect(onFrame).toHaveBeenCalledTimes(2)
    displayFrame()
    expect(onFrame).toHaveBeenCalledTimes(2)
  })

  it('播放中被移除的视频在下一个显示帧停止轮询', () => {
    const video = createVideo({ playing: true, frameCallback: false })
    root.append(video.element)
    const onFrame = vi.fn()
    new VideoClock(onFrame).attach(root)

    video.element.remove()
    displayFrame()
    expect(onFrame).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('停止跟踪时取消循环', () => {
    const video = createVideo({ playing: true, frameCallback: false })
    root.append(video.element)
    const onFrame = vi.fn()
    const clock = new VideoClock(onFrame)
    clock.attach(root)

    clock.detach()
    expect(frames.size).toBe(0)
    displayFrame()
    expect(onFrame).not.toHaveBeenCalled()
  })
})
