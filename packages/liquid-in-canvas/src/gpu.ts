/// <reference path="./html-in-canvas.d.ts" />
import type { WebGPURenderer } from 'three/webgpu'
import { BufferGeometry, ExternalTexture, Float32BufferAttribute, LinearSRGBColorSpace, SRGBColorSpace } from 'three/webgpu'

/** 画布直接以 sRGB 视图写入时需要接管的 three.js 内部工具。 */
interface CanvasFormatUtils {
  getPreferredCanvasFormat: () => string
}

/**
 * 让画布以 sRGB 视图接收绘制，由硬件在写入时编码 sRGB，混合仍在线性空间进行。
 *
 * three.js 的输出色彩空间与线性工作空间不同时，会先把整个场景画进一张全尺寸半精度纹理，
 * 再用一遍全屏绘制转换到画布。在 DPR 2 下这一遍约占每帧 GPU 时间的四成。
 * WebGPU 不允许把画布配置成 sRGB 格式，但允许 8 位画布使用 sRGB 视图，
 * 因此这里改写画布配置、每帧的纹理视图和管线颜色格式，省掉中间纹理与转换。
 *
 * 首选画布格式不是 8 位格式时返回 null，渲染器保持 three.js 默认路径。
 */
export function createSrgbCanvasOutput(canvas: HTMLCanvasElement): {
  context: GPUCanvasContext
  /** 渲染器初始化后调用，使管线以 sRGB 视图格式输出。 */
  attach: (renderer: WebGPURenderer) => void
} | null {
  const base = navigator.gpu.getPreferredCanvasFormat()
  if (base !== 'bgra8unorm' && base !== 'rgba8unorm')
    return null
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context)
    return null
  const view: GPUTextureFormat = `${base}-srgb`

  const configure = context.configure.bind(context)
  context.configure = configuration => configure({
    ...configuration,
    format: base,
    viewFormats: [view],
  })
  const getCurrentTexture = context.getCurrentTexture.bind(context)
  context.getCurrentTexture = () => {
    const texture = getCurrentTexture()
    const createView = texture.createView.bind(texture)
    texture.createView = (descriptor?: GPUTextureViewDescriptor) => createView({ format: view, ...descriptor })
    return texture
  }

  return {
    context,
    attach(renderer) {
      const utils = (renderer.backend as unknown as { utils: CanvasFormatUtils }).utils
      utils.getPreferredCanvasFormat = () => view
      // 输出空间等于工作空间时不再创建中间纹理；编码由 sRGB 视图完成。
      renderer.outputColorSpace = LinearSRGBColorSpace
    },
  }
}

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
