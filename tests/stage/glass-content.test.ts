import type { WebGPURenderer } from 'three/webgpu'
import { ExternalTexture, Scene } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiquidGlassLayer } from '@/stage/liquid-glass/LiquidGlassLayer'

vi.mock('@/stage/liquid-glass/ContentBackdrop', () => ({
  ContentBackdrop: class {
    render(backdrop: unknown) { return backdrop }
    dispose() {}
  },
}))
vi.mock('@/stage/liquid-glass/VolumeGroups', () => ({
  VolumeGroups: class {
    sync() {}
    dispose() {}
  },
}))
vi.mock('@/stage/liquid-glass/blur', () => ({
  BackdropBlur: class {
    textures = []
    render() {}
    dispose() {}
  },
}))
vi.mock('@/stage/liquid-glass/content-material', async () => {
  const { MeshBasicMaterial } = await import('three/webgpu')
  return {
    createGlassContent: () => ({
      material: new MeshBasicMaterial(),
      occludedMaterial: new MeshBasicMaterial(),
      setOccluders() {},
      setPanel() {},
      setContent() {},
      setClip() {},
      setOpacity() {},
      dispose() {},
    }),
  }
})

/** 创建可以移动位置的玻璃控件，记录上传操作而不启动 GPU。 */
function setup() {
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 })
  vi.stubGlobal('DOMMatrix', class {
    translate() {
      return this
    }
  })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const canvas = document.createElement('canvas')
  const root = document.createElement('div')
  const anchor = document.createElement('div')
  const element = document.createElement('button')
  element.dataset.liquidGlass = ''
  element.textContent = '浏览系列'
  root.append(anchor)
  anchor.append(element)
  canvas.append(root)
  document.body.append(canvas)
  let top = 100
  Object.defineProperties(canvas, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  })
  Object.defineProperties(element, {
    offsetParent: {
      get: () => anchor,
    },
    offsetWidth: { value: 160 },
    offsetHeight: { value: 60 },
  })
  anchor.getBoundingClientRect = () => new DOMRect(100, top, 160, 60)
  element.getClientRects = () => [
    new DOMRect(100, top, 160, 60),
  ] as unknown as DOMRectList
  canvas.updateElementGeometry = vi.fn()
  canvas.clearElementGeometry = vi.fn()
  canvas.getElementImageDefaultSize = () => ({ width: 160, height: 60 })
  const upload = vi.fn()
  const device = {
    createTexture: ({ size }: { size: { width: number, height: number } }) => ({
      ...size,
      destroy: vi.fn(),
    }),
    queue: { drawElementImageToTexture: upload },
  } as unknown as GPUDevice
  const backdrop = new ExternalTexture({} as GPUTexture)
  const layer = new LiquidGlassLayer({
    canvas,
    root,
    device,
    renderer: {} as WebGPURenderer,
    scene: new Scene(),
    getBackdrop: () => backdrop,
    onInvalidate: vi.fn(),
    onFault: vi.fn(),
  })
  layer.start()
  return {
    layer,
    upload,
    move: (value: number) => { top = value },
    element,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('玻璃内容纹理', () => {
  it('控件部分离屏时保留完整内容纹理', () => {
    const { layer, upload, move } = setup()
    try {
      layer.sync()
      expect(upload).toHaveBeenCalledTimes(1)
      upload.mockClear()
      move(-30)
      for (let frame = 0; frame < 6; frame++)
        layer.sync()
      expect(upload).not.toHaveBeenCalled()
    }
    finally { layer.dispose() }
  })

  it('控件从部分可见变为完全可见时重新上传内容', () => {
    const { layer, upload, move } = setup()
    try {
      for (let frame = 0; frame < 5; frame++)
        layer.sync()
      move(-30)
      layer.sync()
      upload.mockClear()
      move(100)
      layer.sync()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('控件多次完全离屏后都能重新上传内容', () => {
    const { layer, upload, move } = setup()
    try {
      for (let round = 0; round < 3; round++) {
        move(-100)
        layer.sync()
        upload.mockClear()
        move(100)
        layer.sync()
        expect(upload).toHaveBeenCalledTimes(1)
      }
    }
    finally { layer.dispose() }
  })
})
