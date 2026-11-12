import type { VolumeSurface } from '@/stage/liquid-glass/fusion'
import { Scene, Texture, Vector2 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { parseGlassOptions } from '@/stage/liquid-glass/options'
import { VolumeGroups } from '@/stage/liquid-glass/VolumeGroups'

/** 创建一块独立玻璃，水平位置决定是否与其他玻璃相连。 */
function surface(id: number, left: number): VolumeSurface {
  return {
    id,
    left,
    top: 0,
    width: 100,
    height: 100,
    clip: [0, 0, 1000, 1000],
    opacity: 1,
    brightness: 1,
    paintOrder: 0,
    press: 0,
    options: parseGlassOptions(document.createElement('div'), 'light'),
  }
}

describe('三维玻璃组', () => {
  it('成员变化时复用同等数量的材质', () => {
    const scene = new Scene()
    const groups = new VolumeGroups(scene, [
      new Texture(),
    ])
    const viewport = new Vector2(1000, 600)
    const backdrop = new Texture()
    try {
      groups.sync([
        surface(1, 0),
        surface(2, 400),
      ], viewport, backdrop)
      const meshes = [...scene.children]
      const materials = meshes.map(mesh => (mesh as unknown as { material: unknown }).material)
      expect(meshes).toHaveLength(2)

      // 滚动后换成另外两块独立玻璃。
      groups.sync([
        surface(5, 0),
        surface(9, 400),
      ], viewport, backdrop)
      expect(scene.children).toEqual(meshes)
      expect(scene.children.map(mesh => (mesh as unknown as { material: unknown }).material)).toEqual(materials)
      expect(scene.children.every(mesh => mesh.visible)).toBe(true)

      // 两块相连后只用一组，多余实例隐藏但保留。
      groups.sync([
        surface(5, 0),
        surface(9, 110),
      ], viewport, backdrop)
      expect(scene.children.filter(mesh => mesh.visible)).toHaveLength(1)
      expect(scene.children).toHaveLength(3)
    }
    finally {
      groups.dispose()
    }
  })
})
