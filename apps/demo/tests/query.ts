import type { GlassDefaultsPatch, GlassOptics } from 'liquid-in-canvas'
import { setGlassDefaults } from 'liquid-in-canvas'

/**
 * 测量页与画面检查页共用的查询参数，用于在固定条件下比对画面。
 *
 * `?lens=0` 把两种材质的凸透镜强度设为给定值，与没有透镜的旧版本比对时使用。
 */
export function applyGlassQuery(query: URLSearchParams): void {
  if (query.has('lens')) {
    const material = {
      lens: Number(query.get('lens')),
    }
    const patch: GlassDefaultsPatch = {
      materials: {
        regular: { light: material, dark: material },
        clear: { light: material, dark: material },
      },
    }
    setGlassDefaults(patch)
  }
}

/** `?optics=profile` 切换到剖面光学，用于和三维求交比对画面与开销。 */
export function applyStageQuery(stage: { setOptics: (optics: GlassOptics) => void }, query: URLSearchParams): void {
  const optics = query.get('optics')
  if (optics === 'profile' || optics === 'raymarch')
    stage.setOptics(optics)
}
