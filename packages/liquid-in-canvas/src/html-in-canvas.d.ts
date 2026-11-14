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

interface GPUQueue {
  drawElementImageToTexture: (source: GPUElementImageSource, destination: GPUElementImageDestination) => void
}

interface GPUElementImageSource {
  source: Element
  sourceX?: number
  sourceY?: number
  sourceWidth?: number
  sourceHeight?: number
}

interface GPUElementImageDestination {
  texture: GPUTexture
  size?: GPUExtent3D
  colorSpace?: 'srgb' | 'display-p3'
}
