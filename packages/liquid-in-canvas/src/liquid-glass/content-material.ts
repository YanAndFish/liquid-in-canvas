import type { Node, Texture } from 'three/webgpu'
import type { VolumeSurface } from './fusion'
import { float, Fn, max, screenUV, select, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, Vector2, Vector4 } from 'three/webgpu'
import { createContentMask } from './content-mask'

/** 管理玻璃上方的 HTML 内容及其被其他玻璃覆盖的部分。 */
export interface GlassContentHandle {
  /** 绘制没有被上层玻璃覆盖的清晰内容。 */
  material: MeshBasicNodeMaterial
  /** 绘制被覆盖的内容，供背景卷积使用。 */
  occludedMaterial: MeshBasicNodeMaterial
  /** 更新覆盖当前内容的上层玻璃。 */
  setOccluders: (surfaces: readonly VolumeSurface[]) => void
  /** 设置内容、外侧留白和视口的 CSS 尺寸。 */
  setPanel: (size: Vector2, paddedSize: Vector2, viewport: Vector2) => void
  /** 更新文字与控件的透明快照。 */
  setContent: (texture: Texture) => void
  /** 设置可绘制范围，单位为 CSS 像素。 */
  setClip: (left: number, top: number, right: number, bottom: number) => void
  /** 设置内容的透明度。 */
  setOpacity: (opacity: number) => void
  /** 释放两种内容材质。 */
  dispose: () => void
}

/** 将 HTML 快照分成清晰内容和参与背景模糊的内容。 */
export function createGlassContent(content: Texture): GlassContentHandle {
  const contentNode = texture(content)
  const uniforms = {
    clip: uniform(new Vector4(0, 0, 100000, 100000)),
    panelSize: uniform(new Vector2(1, 1)),
    paddedSize: uniform(new Vector2(1, 1)),
    viewport: uniform(new Vector2(1, 1)),
  }
  const masks: ReturnType<typeof createContentMask>[] = []
  /** 将内容分成清晰部分与被上层玻璃覆盖的部分。 */
  const buildContentNode = (occluded: boolean) => Fn(() => {
    const half = uniforms.panelSize.mul(0.5)
    const local = vec2(uv().x.sub(0.5), float(0.5).sub(uv().y)).mul(uniforms.paddedSize)
    const contentUV = local.add(half).div(uniforms.panelSize)
    const pixel = contentNode.sample(contentUV)
    const position = screenUV.mul(uniforms.viewport)
    const valid = contentUV.x.greaterThanEqual(0).and(contentUV.x.lessThanEqual(1)).and(contentUV.y.greaterThanEqual(0)).and(contentUV.y.lessThanEqual(1)).and(position.x.greaterThanEqual(uniforms.clip.x)).and(position.x.lessThanEqual(uniforms.clip.z)).and(position.y.greaterThanEqual(uniforms.clip.y)).and(position.y.lessThanEqual(uniforms.clip.w))
    let coverage: Node<'float'> = float(0)
    for (const mask of masks)
      coverage = max(coverage, mask.coverage(position))
    const portion = occluded
      ? coverage
      : float(1).sub(coverage)
    return vec4(pixel.rgb, pixel.a.mul(select(valid, 1, 0)).mul(portion))
  })()
  const occludedMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  occludedMaterial.colorNode = buildContentNode(true)
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  material.colorNode = buildContentNode(false)

  return {
    material,
    occludedMaterial,
    setOccluders(surfaces) {
      if (surfaces.length > masks.length) {
        while (masks.length < surfaces.length)
          masks.push(createContentMask())
        material.colorNode = buildContentNode(false)
        material.needsUpdate = true
        occludedMaterial.colorNode = buildContentNode(true)
        occludedMaterial.needsUpdate = true
      }
      masks.forEach((mask, i) => mask.update(surfaces[i] ?? null))
    },
    setPanel(size, paddedSize, viewport) {
      uniforms.panelSize.value.copy(size)
      uniforms.paddedSize.value.copy(paddedSize)
      uniforms.viewport.value.copy(viewport)
    },
    setContent(texture) {
      contentNode.value = texture
    },
    setClip(left, top, right, bottom) {
      uniforms.clip.value.set(left, top, right, bottom)
    },
    setOpacity(opacity) {
      material.opacity = opacity
      occludedMaterial.opacity = opacity
    },
    dispose() {
      material.dispose()
      occludedMaterial.dispose()
    },
  }
}
