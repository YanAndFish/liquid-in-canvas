import type { FrameEncoder } from '../frame.hot'
import type { SampledTexture } from '../gpu'
import type { NumberSink, VolumeSurface } from './fusion.hot'
import { HEADER_FLOATS } from '../frame'
import { CONTENT_FLOATS, MASK_FLOATS } from './content-shader'
import { writePressedBox } from './fusion.hot'

export interface ContentSource {
  readonly rect: {
    left: number
    top: number
    width: number
    height: number
  }
  readonly contentRect: {
    left: number
    top: number
    width: number
    height: number
  }
  padding: number
  readonly contentClip: number[]
  contentOpacity: number
  contentScale: number
  contentBlur: number
  contentOriginX: number
  contentOriginY: number
  readonly occluders: VolumeSurface[]
  occluderCount: number
  readonly backdropOccluders: VolumeSurface[]
  backdropOccluderCount: number
  readonly content: SampledTexture | null
}

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
  const { contentRect: rect, padding } = source
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
