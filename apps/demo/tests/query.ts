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

/**
 * `?optics=profile`、`?optics=raymarch`、`?optics=hybrid` 切换光路，用于比对画面与开销。
 * `?cache=0` 关闭混合光路的折射场缓存：连接处每帧逐步求交，运动中也不改用查表。
 * `?reuse=1` 打开实验性的快照复用：页面没有变化的帧沿用上一帧整页快照。
 */
export function applyStageQuery(stage: {
  setOptics: (optics: GlassOptics) => void
  setFieldCache: (enabled: boolean) => void
  setSnapshotReuse?: (enabled: boolean) => void
}, query: URLSearchParams): void {
  if (query.has('cache'))
    stage.setFieldCache(query.get('cache') !== '0')
  if (query.has('reuse'))
    stage.setSnapshotReuse?.(query.get('reuse') !== '0')
  const optics = query.get('optics')
  if (optics === 'profile' || optics === 'raymarch' || optics === 'hybrid')
    stage.setOptics(optics)
}
