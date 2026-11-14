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
  /** 内容绕中心的缩放，与按压和材质化时的体积一致。 */
  contentScale: number
  /** 内容的模糊半径（CSS 像素），显现与退去期间不为零。 */
  contentBlur: number
  /** 缩放的中心相对内容中心的偏移（CSS 像素）。展开时内容从来源处放大后收拢。 */
  contentOriginX: number
  contentOriginY: number
  /** 覆盖这块内容的上层玻璃，前 `occluderCount` 项有效。画布里这些部分被裁掉。 */
  readonly occluders: VolumeSurface[]
  occluderCount: number
  /**
   * `occluders` 中仍要把被覆盖部分写进页面背景的那些，前 `backdropOccluderCount` 项有效。
   * 位于更高一级背景、能直接看到这块玻璃的上层玻璃不在其中：它的背景已经画了完整的内容。
   */
  readonly backdropOccluders: VolumeSurface[]
  backdropOccluderCount: number
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
 * `occluders` 的前 `occluderCount` 项写成遮挡轮廓；管线按这个数量取用，见 `createContentPipelines()`。
 */
export function writeContent(
  frame: FrameEncoder,
  source: ContentSource,
  occluders: readonly VolumeSurface[],
  occluderCount: number,
  cssWidth: number,
  cssHeight: number,
  targetWidth: number,
  targetHeight: number,
): number {
  const { rect, padding } = source
  const start = frame.rect(
    HEADER_FLOATS + CONTENT_FLOATS + occluderCount * MASK_FLOATS,
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
  data[offset + 9] = source.contentScale
  data[offset + 10] = source.contentBlur
  data[offset + 12] = source.contentOriginX
  data[offset + 13] = source.contentOriginY
  offset += CONTENT_FLOATS
  for (let i = 0; i < occluderCount; i++) {
    writeContentMask(data, offset, occluders[i]!)
    offset += MASK_FLOATS
  }
  return start * 4
}
