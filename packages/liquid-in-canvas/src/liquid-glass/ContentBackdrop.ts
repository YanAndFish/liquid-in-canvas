import type { Texture, WebGPURenderer } from 'three/webgpu'
import { screenUV, texture } from 'three/tsl'
import { HalfFloatType, Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, RenderTarget, Scene } from 'three/webgpu'

/** 一块需要写入模糊背景的内容。 */
interface ContentOverlay {
  /** 提供内容位置、尺寸及几何体的场景网格。 */
  mesh: Mesh
  /** 仅输出被上层玻璃覆盖部分的内容材质。 */
  material: MeshBasicNodeMaterial
}

/** 把被上层玻璃覆盖的 HTML 内容加入背景，供折射和高斯卷积取样。 */
export class ContentBackdrop {
  private readonly renderer: WebGPURenderer
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly source: ReturnType<typeof texture<'vec4'>>
  private readonly material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, toneMapped: false })
  private readonly contents = new Map<number, Mesh>()

  constructor(renderer: WebGPURenderer, backdrop: Texture) {
    this.renderer = renderer
    this.source = texture(backdrop)
    this.material.colorNode = this.source.sample(screenUV)
    const mesh = new Mesh(this.geometry, this.material)
    mesh.renderOrder = -1
    mesh.frustumCulled = false
    this.scene.add(mesh)
  }

  /** 合成当前可见的被遮挡内容；没有重叠时直接返回页面快照。 */
  render(backdrop: Texture, overlays: ContentOverlay[], width: number, height: number): Texture {
    const used = new Set(overlays.map(overlay => overlay.mesh.id))
    for (const [id, mesh] of this.contents) {
      if (!used.has(id)) {
        this.scene.remove(mesh)
        this.contents.delete(id)
      }
    }
    if (overlays.length === 0)
      return backdrop
    this.source.value = backdrop
    this.target.setSize(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)))
    overlays.forEach((overlay, i) => {
      let mesh = this.contents.get(overlay.mesh.id)
      if (!mesh) {
        mesh = new Mesh(overlay.mesh.geometry, overlay.material)
        mesh.frustumCulled = false
        this.contents.set(overlay.mesh.id, mesh)
        this.scene.add(mesh)
      }
      mesh.position.copy(overlay.mesh.position)
      mesh.scale.copy(overlay.mesh.scale)
      mesh.renderOrder = i
    })
    const previous = this.renderer.getRenderTarget()
    try {
      this.renderer.setRenderTarget(this.target)
      this.renderer.render(this.scene, this.camera)
    }
    finally {
      this.renderer.setRenderTarget(previous)
    }
    return this.target.texture
  }

  /** 释放离屏背景，内容材质和内容几何体由各表面管理。 */
  dispose(): void {
    this.scene.clear()
    this.contents.clear()
    this.material.dispose()
    this.geometry.dispose()
    this.target.dispose()
  }
}
