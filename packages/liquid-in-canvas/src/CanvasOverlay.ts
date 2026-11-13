import type { BufferGeometry, Scene } from 'three/webgpu'
import type { ElementTexture } from './gpu'
import { Mesh, MeshBasicMaterial } from 'three/webgpu'
import { STAGE_OVERLAY_ATTR } from './contract'
import { createElementTexture, disposeElementTexture, uploadElement } from './gpu'
import { GLASS_LAYER_RANGE, OVERLAY_TOP_LAYER, overlayRenderOrder } from './render-order'

/** 读取前景层声明的层级；没有声明或无法解析时位于所有玻璃之上。 */
export function parseOverlayLayer(raw: string | null): number {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value))
    return OVERLAY_TOP_LAYER
  return Math.min(OVERLAY_TOP_LAYER, Math.max(GLASS_LAYER_RANGE[0], value))
}

/**
 * 透明前景层：整层单独上传，按声明的层级插在玻璃之间。
 *
 * 页面快照总在所有玻璃之下。需要盖住一部分玻璃、又被另一部分玻璃盖住的内容
 * （例如跨越多块玻璃的过渡动画）放进前景层。
 */
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
    this.mesh.renderOrder = this.order()
    this.mesh.visible = false
    scene.add(this.mesh)
    element.setAttribute('drawable', '')
    canvas.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix(),
    })
  }

  /** 前景层当前的场景顺序。 */
  get renderOrder(): number {
    return this.mesh.renderOrder
  }

  /** 前景层为空时不上传也不绘制。 */
  sync(): void {
    this.mesh.renderOrder = this.order()
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

  private order(): number {
    return overlayRenderOrder(parseOverlayLayer(this.element.getAttribute(STAGE_OVERLAY_ATTR)))
  }
}
