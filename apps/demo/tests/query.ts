import type { GlassDefaultsPatch, GlassOptics } from 'liquid-in-canvas'
import { setGlassDefaults } from 'liquid-in-canvas'

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

export function applyStageQuery(stage: { setOptics: (optics: GlassOptics) => void, setFieldCache: (enabled: boolean) => void }, query: URLSearchParams): void {
  if (query.has('cache'))
    stage.setFieldCache(query.get('cache') !== '0')
  const optics = query.get('optics')
  if (optics === 'profile' || optics === 'raymarch' || optics === 'hybrid')
    stage.setOptics(optics)
}
