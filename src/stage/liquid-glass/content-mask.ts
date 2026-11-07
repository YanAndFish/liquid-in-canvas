import type { Node } from 'three/webgpu'
import type { VolumeSurface } from './fusion'
import { float, length, max, min, select, smoothstep, uniform, vec2 } from 'three/tsl'
import { Vector4 } from 'three/webgpu'

/** 创建一块上层玻璃的轮廓参数，供清晰内容与背景内容共用。 */
export function createContentMask() {
  const box = uniform(new Vector4())
  const radius = uniform(new Vector4())
  const clip = uniform(new Vector4())
  const enabled = uniform(0)
  return {
    /** 更新轮廓；null 表示停用这个遮挡位置。 */
    update(surface: VolumeSurface | null) {
      enabled.value = surface ? 1 : 0
      if (!surface)
        return
      box.value.set(surface.left + surface.width / 2, surface.top + surface.height / 2, surface.width / 2 * (1 + surface.press * 0.018), surface.height / 2 * (1 - surface.press * 0.025))
      radius.value.set(...surface.options.radius)
      clip.value.set(...surface.clip)
    },
    /** 返回屏幕坐标处的覆盖比例，边缘使用亚像素过渡。 */
    coverage(position: Node<'vec2'>) {
      const local = position.sub(box.xy)
      const corner = min(select(local.x.lessThan(0), select(local.y.lessThan(0), radius.x, radius.w), select(local.y.lessThan(0), radius.y, radius.z)), min(box.z, box.w))
      const q = local.abs().sub(box.zw).add(corner)
      const distance = length(max(q, vec2(0))).add(min(max(q.x, q.y), 0)).sub(corner)
      const clipped = max(max(clip.x.sub(position.x), position.x.sub(clip.z)), max(clip.y.sub(position.y), position.y.sub(clip.w)))
      return float(1).sub(smoothstep(-0.5, 0.5, max(distance, clipped))).mul(enabled)
    },
  }
}
