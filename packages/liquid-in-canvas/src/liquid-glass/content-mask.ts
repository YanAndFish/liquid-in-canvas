import type { VolumeSurface } from './fusion'
import { pressedBox } from './fusion'

/** 每块上层玻璃的轮廓占用的浮点数个数，对应着色器里的 `Mask`。 */
export const MASK_FLOATS = 12

/** 上层玻璃轮廓的结构体，以及屏幕坐标处的覆盖比例；边缘使用亚像素过渡。 */
export const MASK_SHADER = /* wgsl */`
struct Mask {
  // 中心坐标与半宽高。
  box: vec4f,
  // 左上、右上、右下、左下的圆角半径。
  radius: vec4f,
  // 裁剪范围：左、上、右、下。
  clip: vec4f,
}

fn mask_coverage(position: vec2f, mask: Mask) -> f32 {
  let local = position - mask.box.xy;
  let corner = min(select(select(mask.radius.z, mask.radius.y, local.y < 0.0), select(mask.radius.w, mask.radius.x, local.y < 0.0), local.x < 0.0), min(mask.box.z, mask.box.w));
  let q = abs(local) - mask.box.zw + corner;
  let distance = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - corner;
  let clipped = max(max(mask.clip.x - position.x, position.x - mask.clip.z), max(mask.clip.y - position.y, position.y - mask.clip.w));
  return 1.0 - smoothstep(-0.5, 0.5, max(distance, clipped));
}
`

/** 把一块上层玻璃的轮廓写入 uniform。轮廓与体积距离场使用同一个按压后的形状。 */
export function writeContentMask(data: Float32Array, start: number, surface: VolumeSurface): void {
  data.set(pressedBox(surface), start)
  data.set(surface.options.radius, start + 4)
  data.set(surface.clip, start + 8)
}
