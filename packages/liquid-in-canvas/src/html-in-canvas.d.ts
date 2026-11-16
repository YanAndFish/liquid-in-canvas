interface HTMLCanvasElement {
  content: 'fallback' | 'drawable'
  requestPaint: () => void
  updateElementGeometry: (element: Element, options?: ElementGeometryOptions) => void
  clearElementGeometry: (element: Element) => void
  getElementImageDefaultSize: (element: Element) => { width: number, height: number }
}

interface ElementGeometryOptions {
  canvasTransform?: DOMMatrix
  canvasClip?: DOMRectInit
  preserveHitTestOrder?: boolean
}

/**
 * 画布的 `paint` 事件。`changedElements` 列出这次渲染更新里重新绘制过的 drawable 后代
 * （Chromium 按元素的绘制层“自身或后代需要重绘”判定，嵌套 drawable 重绘时外层也会列出）。
 * 只到元素粒度，没有变化的矩形。`requestPaint()` 触发、页面没有重绘时为空。
 */
interface CanvasPaintEvent extends Event {
  readonly changedElements: readonly Element[]
}

interface GPUQueue {
  drawElementImageToTexture: (source: GPUElementImageSource, destination: GPUElementImageDestination) => void
}

/**
 * 规范里的 `GPUDrawElementImageSource`。源矩形相对元素的边框盒，单位是 CSS 像素
 * （Chromium 乘以元素的缩放倍率换成物理像素）；四项要么都给、要么都不给。
 * 每次调用浏览器都按目标尺寸新建一张表面，只光栅化落在源矩形里的部分，再拷进目标纹理。
 */
interface GPUElementImageSource {
  source: Element
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
}

/**
 * 规范里的 `GPUDrawElementImageDestination`，继承 `GPUImageCopyTextureTagged`：
 * `origin` 是写入目标纹理的起点。缺省 `size` 时是源矩形按画布网格换算的尺寸。
 * Chromium 只把拷贝尺寸夹到纹理尺寸，不扣除 `origin`，越界会产生校验错误，调用方要自己夹取。
 */
interface GPUElementImageDestination {
  texture: GPUTexture
  origin?: GPUOrigin3D
  size?: GPUExtent3D
  colorSpace?: 'srgb' | 'display-p3'
}
