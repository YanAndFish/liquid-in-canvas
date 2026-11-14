import type { FrameEncoder } from '../frame.hot'
import type { SampledTexture } from '../gpu'
import type { NumberSink, VolumeSurface } from './fusion.hot'
import { HEADER_FLOATS } from '../frame'
import { CONTENT_FLOATS, MASK_FLOATS } from './content-shader'
import { writePressedBox } from './fusion.hot'

/** 玻璃上一块 HTML 内容在本帧的位置与状态，长度使用 CSS 像素。舞台为每块玻璃保留一个对象。 */
export interface ContentSource {
  /** 内容矩形，即玻璃元素自身在视口中的位置。 */
  readonly rect: {
    left: number
    top: number
    width: number
    height: number
  }
  /** 绘制矩形在内容四周留出的余量，容纳阴影。 */
  padding: number
  /** 可绘制范围：左、上、右、下。 */
  readonly contentClip: number[]
  /** 内容的不透明度。 */
  contentOpacity: number
  /** 覆盖这块内容的上层玻璃，前 `occluderCount` 项有效。 */
  readonly occluders: VolumeSurface[]
  occluderCount: number
  /** 内容快照；嵌套玻璃没有自己的快照，为 null。 */
  readonly content: SampledTexture | null
}

/** 把一块上层玻璃的轮廓写入 uniform。轮廓与体积距离场使用同一个按压后的形状。 */
export function writeContentMask(target: NumberSink, offset: number, surface: VolumeSurface): void {
  writePressedBox(target, offset, surface)
  const radius = surface.options.radius
  target[offset + 4] = radius[0]
  target[offset + 5] = radius[1]
  target[offset + 6] = radius[2]
  target[offset + 7] = radius[3]
  const clip = surface.clip
  target[offset + 8] = clip[0]!
  target[offset + 9] = clip[1]!
  target[offset + 10] = clip[2]!
  target[offset + 11] = clip[3]!
}

/**
 * 把一块内容写入本帧的 uniform，返回绘制项的字节偏移。同一块内容画到不同尺寸的目标时各写一次。
 * 管线按遮挡数量取用，见 `createContentPipelines()`。
 */
export function writeContent(
  frame: FrameEncoder,
  source: ContentSource,
  cssWidth: number,
  cssHeight: number,
  targetWidth: number,
  targetHeight: number,
): number {
  const { rect, padding } = source
  const occluders = source.occluderCount
  const start = frame.rect(
    HEADER_FLOATS + CONTENT_FLOATS + occluders * MASK_FLOATS,
    rect.left - padding,
    rect.top - padding,
    rect.left + rect.width + padding,
    rect.top + rect.height + padding,
    cssWidth,
    cssHeight,
    targetWidth,
    targetHeight,
  )
  const data = frame.data
  let offset = start + HEADER_FLOATS
  const clip = source.contentClip
  data[offset] = clip[0]!
  data[offset + 1] = clip[1]!
  data[offset + 2] = clip[2]!
  data[offset + 3] = clip[3]!
  data[offset + 4] = rect.width
  data[offset + 5] = rect.height
  data[offset + 6] = rect.width + padding * 2
  data[offset + 7] = rect.height + padding * 2
  data[offset + 8] = source.contentOpacity
  offset += CONTENT_FLOATS
  for (let i = 0; i < occluders; i++) {
    writeContentMask(data, offset, source.occluders[i]!)
    offset += MASK_FLOATS
  }
  return start * 4
}
