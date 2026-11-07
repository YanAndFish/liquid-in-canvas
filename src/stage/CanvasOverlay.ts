import type { BufferGeometry, Scene } from 'three/webgpu'
import { ExternalTexture, Mesh, MeshBasicMaterial, SRGBColorSpace } from 'three/webgpu'

/** 把共享商品动画绘制在导航玻璃之上、购物袋之下。 */
export class CanvasOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly element: HTMLElement
  private readonly device: GPUDevice
  private readonly scene: Scene
  private texture: GPUTexture | null = null
  private external: ExternalTexture | null = null
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
    this.mesh.renderOrder = 950
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
    if (!this.texture || this.texture.width !== this.canvas.width || this.texture.height !== this.canvas.height) {
      this.external?.dispose()
      this.texture?.destroy()
      this.texture = this.device.createTexture({
        size: { width: this.canvas.width, height: this.canvas.height },
        format: 'rgba8unorm-srgb',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.external = new ExternalTexture(this.texture)
      this.external.colorSpace = SRGBColorSpace
      this.material.map = this.external
      this.material.needsUpdate = true
    }
    this.device.queue.drawElementImageToTexture(
      { source: this.element },
      {
        texture: this.texture,
        size: { width: this.canvas.width, height: this.canvas.height },
        colorSpace: 'srgb',
      },
    )
  }

  /** 释放前景纹理，几何体由舞台统一释放。 */
  dispose(): void {
    this.canvas.clearElementGeometry(this.element)
    this.element.removeAttribute('drawable')
    this.scene.remove(this.mesh)
    this.material.dispose()
    this.external?.dispose()
    this.texture?.destroy()
  }
}
