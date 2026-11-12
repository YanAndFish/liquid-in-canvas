import { BufferGeometry, ExternalTexture, Float32BufferAttribute, SRGBColorSpace } from 'three/webgpu'

/** 一张接收 HTML 快照的 GPU 纹理及其 three.js 包装。 */
export interface ElementTexture {
  texture: GPUTexture
  external: ExternalTexture
}

/** 创建可由 `drawElementImageToTexture()` 写入的 sRGB 纹理。 */
export function createElementTexture(device: GPUDevice, width: number, height: number): ElementTexture {
  const texture = device.createTexture({
    size: { width, height },
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const external = new ExternalTexture(texture)
  external.colorSpace = SRGBColorSpace
  return { texture, external }
}

/** 释放包装与底层纹理。 */
export function disposeElementTexture(target: ElementTexture | null): void {
  target?.external.dispose()
  target?.texture.destroy()
}

/** 把元素的当前绘制记录写入整张纹理。 */
export function uploadElement(device: GPUDevice, element: Element, texture: GPUTexture): void {
  device.queue.drawElementImageToTexture(
    { source: element },
    {
      texture,
      size: { width: texture.width, height: texture.height },
      colorSpace: 'srgb',
    },
  )
}

/** 覆盖整个裁剪空间的单个三角形，比两个三角形的四边形少一条对角线接缝。 */
export function createFullscreenTriangle(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
  geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2))
  return geometry
}
