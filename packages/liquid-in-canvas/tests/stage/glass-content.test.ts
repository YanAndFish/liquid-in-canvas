import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElementTexture } from '../../src/gpu'
import { LiquidGlassLayer } from '../../src/liquid-glass/LiquidGlassLayer'
import { createFakeGpu } from '../helpers/fake-gpu'

const { planVolumes } = vi.hoisted(() => ({
  planVolumes: vi.fn((_surfaces: unknown[]) => []),
}))

vi.mock('../../src/liquid-glass/ContentBackdrop', () => ({
  ContentBackdrop: class {
    static targetSize() { return { width: 1, height: 1 } }
    plan(backdrop: unknown) { return backdrop }
    encode() {}
    dispose() {}
  },
}))
vi.mock('../../src/liquid-glass/VolumeGroups', () => ({
  VolumeGroups: class {
    plan = planVolumes
    warm() {}
    encode() {}
    dispose() {}
  },
}))
vi.mock('../../src/liquid-glass/blur', () => ({
  BackdropBlur: class {
    views = []
    generation = 0
    plan() {}
    encode() {}
    dispose() {}
  },
}))
vi.mock('../../src/liquid-glass/content-material', () => ({
  planGlassContent: () => () => ({}),
  warmContentPipeline() {},
}))

/** 创建可以移动位置的玻璃控件，记录上传操作而不启动 GPU。 */
function setup(height = 60) {
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
    offsetHeight: { value: height },
  })
  anchor.getBoundingClientRect = () => new DOMRect(100, top, 160, height)
  element.getClientRects = () => [
    new DOMRect(100, top, 160, height),
  ] as unknown as DOMRectList
  canvas.updateElementGeometry = vi.fn()
  canvas.clearElementGeometry = vi.fn()
  canvas.getElementImageDefaultSize = () => ({ width: 160, height })
  const { gpu, queue } = createFakeGpu()
  const upload = queue.drawElementImageToTexture
  const backdrop = createElementTexture(gpu, 800, 600)
  const layer = new LiquidGlassLayer({
    canvas,
    root,
    gpu,
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
    root,
    /** 模拟浏览器为当前玻璃生成绘制记录后的通知。 */
    paint: () => layer.sync(Object.assign(new Event('paint'), {
      changedElements: [element],
    })),
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('玻璃内容纹理', () => {
  it('控件部分离屏时保留完整内容纹理', () => {
    const { layer, upload, move, paint } = setup()
    try {
      layer.sync()
      paint()
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
    const { layer, upload, move, paint } = setup()
    try {
      for (let frame = 0; frame < 5; frame++)
        paint()
      move(-30)
      layer.sync()
      upload.mockClear()
      move(100)
      layer.sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('控件多次完全离屏后都能重新上传内容', () => {
    const { layer, upload, move, paint } = setup()
    try {
      for (let round = 0; round < 3; round++) {
        move(-100)
        layer.sync()
        upload.mockClear()
        move(100)
        layer.sync()
        paint()
        expect(upload).toHaveBeenCalledTimes(1)
      }
    }
    finally { layer.dispose() }
  })

  it('玻璃重新进入视口时等待新绘制记录再更新纹理', () => {
    const { layer, upload, move, paint } = setup()
    try {
      layer.sync()
      paint()
      move(-100)
      layer.sync()
      upload.mockClear()
      move(100)
      for (let frame = 0; frame < 6; frame++)
        layer.sync()
      expect(upload).not.toHaveBeenCalled()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('首次只露出部分的玻璃也会上传可见内容', () => {
    const { layer, upload, move, paint } = setup()
    try {
      move(-30)
      layer.sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('高于视口的玻璃会上传可见内容', () => {
    const { layer, upload, paint } = setup(900)
    try {
      layer.sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('购物袋遮罩压暗背景玻璃时保留完整覆盖率', () => {
    const { layer, root } = setup()
    try {
      const shell = document.createElement('div')
      shell.dataset.glassModal = ''
      const scrim = document.createElement('div')
      scrim.dataset.glassScrim = ''
      scrim.style.backgroundColor = 'rgba(4, 4, 6, 0.52)'
      shell.append(scrim)
      root.append(shell)
      layer.sync()
      expect(planVolumes.mock.lastCall?.[0][0]).toMatchObject({ opacity: 1, brightness: 0.48 })
      shell.remove()
      layer.sync()
      expect(planVolumes.mock.lastCall?.[0][0]).toMatchObject({ opacity: 1, brightness: 1 })
    }
    finally { layer.dispose() }
  })
})
