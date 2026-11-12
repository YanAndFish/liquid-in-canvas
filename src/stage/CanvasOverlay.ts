import type { BufferGeometry, Scene } from 'three/webgpu'
import type { ElementTexture } from './gpu'
import { Mesh, MeshBasicMaterial } from 'three/webgpu'
import { createElementTexture, disposeElementTexture, uploadElement } from './gpu'
import { OVERLAY_RENDER_ORDER } from './render-order'

/** 把共享商品动画绘制在导航玻璃之上、购物袋之下。 */
export class CanvasOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly element: HTMLElement
  private readonly device: GPUDevice
  private readonly scene: Scene
  private target: ElementTexture | null = null
  private readonly material = new MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })

  private readonly mesh: Mesh

  constructor(
    canvas: HTMLCanvasElement,
    element: HTMLElement,
    device: GPUDevice,
    scene: Scene,
    geometry: BufferGeometry,
  ) {
    this.canvas = canvas
    this.element = element
    this.device = device
    this.scene = scene
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = OVERLAY_RENDER_ORDER
    this.mesh.visible = false
    scene.add(this.mesh)
    element.setAttribute('drawable', '')
    canvas.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix(),
    })
  }

  /** 仅在有商品动画时上传透明前景。 */
  sync(): void {
    this.mesh.visible = this.element.childElementCount > 0
    if (!this.mesh.visible)
      return
    const { width, height } = this.canvas
    if (!this.target || this.target.texture.width !== width || this.target.texture.height !== height) {
      disposeElementTexture(this.target)
      this.target = createElementTexture(this.device, width, height)
      this.material.map = this.target.external
      this.material.needsUpdate = true
    }
    uploadElement(this.device, this.element, this.target.texture)
  }

  /** 释放前景纹理，几何体由舞台统一释放。 */
  dispose(): void {
    this.canvas.clearElementGeometry(this.element)
    this.element.removeAttribute('drawable')
    this.scene.remove(this.mesh)
    this.material.dispose()
    disposeElementTexture(this.target)
    this.target = null
  }
}
