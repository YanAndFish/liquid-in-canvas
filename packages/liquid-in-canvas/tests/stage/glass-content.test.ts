import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrawList } from '../../src/frame.hot'
import { createElementTexture } from '../../src/gpu'
import { LiquidGlassLayer } from '../../src/liquid-glass/LiquidGlassLayer'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 创建可以移动位置的玻璃控件。每帧的代码真实运行，GPU 由记录调用的假设备代替。 */
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
  const list = new DrawList()
  /** 画一帧，返回画布遍里的绘制项数量。 */
  const sync = (event?: Event) => {
    gpu.frame.begin()
    list.reset()
    layer.sync(event, list)
    return list.count
  }
  return {
    layer,
    upload,
    sync,
    anchor,
    move: (value: number) => { top = value },
    element,
    root,
    /** 模拟浏览器为当前玻璃生成绘制记录后的通知。 */
    paint: () => sync(Object.assign(new Event('paint'), {
      changedElements: [element],
    })),
  }
}

/** 在玻璃里放一个按钮，尺寸与位置由 `left` 决定。 */
function nestedButton(host: HTMLElement, anchor: HTMLElement, left: number): HTMLButtonElement {
  const button = document.createElement('button')
  host.append(button)
  Object.defineProperties(button, {
    offsetParent: {
      get: () => anchor,
    },
    offsetLeft: { value: left, configurable: true },
    offsetTop: { value: 6 },
    offsetWidth: { value: 60 },
    offsetHeight: { value: 40 },
  })
  button.getClientRects = () => [
    new DOMRect(100 + left, 106, 60, 40),
  ] as unknown as DOMRectList
  return button
}

/** 等待变更记录送达。 */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('玻璃内容纹理', () => {
  it('控件部分离屏时保留完整内容纹理', () => {
    const { layer, upload, move, paint, sync } = setup()
    try {
      sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
      upload.mockClear()
      move(-30)
      for (let frame = 0; frame < 6; frame++)
        sync()
      expect(upload).not.toHaveBeenCalled()
    }
    finally { layer.dispose() }
  })

  it('控件从部分可见变为完全可见时重新上传内容', () => {
    const { layer, upload, move, paint, sync } = setup()
    try {
      for (let frame = 0; frame < 5; frame++)
        paint()
      move(-30)
      sync()
      upload.mockClear()
      move(100)
      sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('控件多次完全离屏后都能重新上传内容', () => {
    const { layer, upload, move, paint, sync } = setup()
    try {
      for (let round = 0; round < 3; round++) {
        move(-100)
        sync()
        upload.mockClear()
        move(100)
        sync()
        paint()
        expect(upload).toHaveBeenCalledTimes(1)
      }
    }
    finally { layer.dispose() }
  })

  it('玻璃重新进入视口时等待新绘制记录再更新纹理', () => {
    const { layer, upload, move, paint, sync } = setup()
    try {
      sync()
      paint()
      move(-100)
      sync()
      upload.mockClear()
      move(100)
      for (let frame = 0; frame < 6; frame++)
        sync()
      expect(upload).not.toHaveBeenCalled()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('首次只露出部分的玻璃也会上传可见内容', () => {
    const { layer, upload, move, paint, sync } = setup()
    try {
      move(-30)
      sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('高于视口的玻璃会上传可见内容', () => {
    const { layer, upload, paint, sync } = setup(900)
    try {
      sync()
      paint()
      expect(upload).toHaveBeenCalledTimes(1)
    }
    finally { layer.dispose() }
  })

  it('购物袋遮罩压暗背景玻璃时保留完整覆盖率', () => {
    const { layer, root, sync } = setup()
    try {
      const shell = document.createElement('div')
      shell.dataset.glassModal = ''
      const scrim = document.createElement('div')
      scrim.dataset.glassScrim = ''
      scrim.style.backgroundColor = 'rgba(4, 4, 6, 0.52)'
      shell.append(scrim)
      root.append(shell)
      sync()
      expect(layer.surfaces[0]!.volume).toMatchObject({ opacity: 1, brightness: 0.48 })
      shell.remove()
      sync()
      expect(layer.surfaces[0]!.volume).toMatchObject({ opacity: 1, brightness: 1 })
    }
    finally { layer.dispose() }
  })

  it('嵌套玻璃只有体积：不上传内容、不改为 drawable，也不遮挡外层的文字', async () => {
    const { layer, upload, element, anchor, sync, paint } = setup()
    try {
      sync()
      paint()
      upload.mockClear()
      const button = nestedButton(element, anchor, 6)
      button.dataset.liquidGlass = ''
      await flush()
      sync()
      const nested = layer.surfaces.find(surface => surface.element === button)!
      expect(nested.host?.element).toBe(element)
      expect(nested.content).toBeNull()
      expect(button.hasAttribute('drawable')).toBe(false)
      expect(nested.volume.layer).toBe(0)
      expect(layer.surfaces.find(surface => surface.element === element)!.occluderCount).toBe(0)
      expect(upload).not.toHaveBeenCalledWith(expect.objectContaining({ source: button }), expect.anything())
    }
    finally { layer.dispose() }
  })

  it('同名的激活玻璃换到另一个按钮时，体积从旧位置流向新位置', async () => {
    const { layer, element, anchor, sync } = setup()
    try {
      const first = nestedButton(element, anchor, 6)
      const second = nestedButton(element, anchor, 90)
      first.dataset.liquidGlass = ''
      first.dataset.glassMorph = 'tabs'
      await flush()
      sync()
      const before = layer.surfaces.find(surface => surface.element === first)!.volume.left
      expect(before).toBe(106)

      delete first.dataset.liquidGlass
      second.dataset.liquidGlass = ''
      second.dataset.glassMorph = 'tabs'
      await flush()
      sync()
      const moved = layer.surfaces.find(surface => surface.element === second)!
      expect(moved.flow?.active).toBe(true)
      // 这一帧体积还在旧位置附近，没有直接跳到新按钮上。
      expect(moved.volume.left).toBeLessThan(150)
      expect(layer.surfaces.some(surface => surface.element === first)).toBe(false)
    }
    finally { layer.dispose() }
  })

  it('同名玻璃仍在页面上时，新玻璃从它里面流出来；移除后体积流回它并被吸收', async () => {
    const { layer, element, anchor, sync } = setup()
    const advance = (seconds: number) => (layer as unknown as { frame: { advanceMotion: (s: number, p: null, r: boolean) => boolean } })
      .frame
      .advanceMotion(seconds, null, false)
    try {
      const button = nestedButton(element, anchor, 6)
      const panel = nestedButton(element, anchor, 90)
      button.dataset.liquidGlass = ''
      button.dataset.glassMorph = 'pop'
      await flush()
      sync()
      sync()
      const source = layer.surfaces.find(surface => surface.element === button)!

      panel.dataset.liquidGlass = ''
      panel.dataset.glassMorph = 'pop'
      await flush()
      sync()
      const grown = layer.surfaces.find(surface => surface.element === panel)!
      expect(grown.partner).toBe(source)
      expect(grown.flow?.active).toBe(true)
      // 从按钮的位置出发，融合距离从接近零开始，两块玻璃不会一起鼓起来。
      expect(grown.volume.left).toBeLessThan(110)
      expect(grown.volume.fusion).toBeLessThan(grown.options.fusion)
      // 按钮下一帧仍在页面上，不算交出体积。
      sync()
      expect(source.handedOver).toBe(false)
      for (let frame = 0; frame < 120; frame++) {
        advance(1 / 60)
        sync()
      }
      expect(grown.flow?.active).toBe(false)
      expect(grown.partner).toBeNull()
      expect(grown.volume.fusion).toBe(grown.options.fusion)

      delete panel.dataset.liquidGlass
      await flush()
      expect(layer.ghosts).toHaveLength(1)
      expect(layer.ghosts[0]!.target).toBe(source)
      sync()
      const ghost = layer.ghosts[0]!.volume
      expect(ghost.left).toBeGreaterThan(150)
      for (let frame = 0; frame < 240 && layer.ghosts.length > 0; frame++) {
        advance(1 / 60)
        sync()
      }
      expect(layer.ghosts).toHaveLength(0)
    }
    finally { layer.dispose() }
  })

  it('新出现的玻璃从零材质化，移除后在原处退去，再释放内容纹理', async () => {
    const { layer, sync, element } = setup()
    const frame = (layer as unknown as { frame: { advanceMotion: (seconds: number, pressed: HTMLElement | null, reduced: boolean) => boolean } }).frame
    const settle = () => {
      let steps = 0
      while (steps < 240 && frame.advanceMotion(1 / 60, null, false))
        steps++
    }
    try {
      sync()
      const surface = layer.surfaces[0]!
      expect(surface.materialize.value).toBe(0)
      expect(surface.reveal).toBe(0)
      expect(surface.contentBlur).toBeGreaterThan(0)
      settle()
      expect(surface.materialize.value).toBe(1)
      // 内容显现只收敛一次：清晰、原尺寸之后不再随玻璃变化。
      expect(surface.reveal).toBe(1)
      sync()
      expect(surface.contentBlur).toBe(0)
      expect(surface.contentScale).toBe(1)

      element.remove()
      await flush()
      expect(layer.surfaces).toHaveLength(0)
      expect(layer.fading).toEqual([surface])
      const texture = surface.content!.texture
      // 退去期间仍然绘制体积与内容。
      expect(sync()).toBeGreaterThan(0)
      expect(texture.destroy).not.toHaveBeenCalled()
      settle()
      expect(surface.materialize.value).toBe(0)
      sync()
      expect(layer.fading).toHaveLength(0)
      expect(texture.destroy).toHaveBeenCalled()
      expect(surface.content).toBeNull()
    }
    finally {
      layer.dispose()
    }
  })

  it('隐藏期间读到的空布局不会让迁移玻璃流走，重新显示时在原处出现', async () => {
    const { layer, sync, element } = setup()
    const frame = (layer as unknown as { frame: { advanceMotion: (seconds: number, pressed: HTMLElement | null, reduced: boolean) => boolean } }).frame
    const settle = () => {
      for (let steps = 0; steps < 240 && frame.advanceMotion(1 / 60, null, false); steps++)
        sync()
    }
    let shown = true
    let offsetLeft = 0
    element.checkVisibility = () => shown
    Object.defineProperty(element, 'offsetLeft', {
      get: () => offsetLeft,
      configurable: true,
    })
    try {
      element.dataset.glassMorph = ''
      await flush()
      sync()
      settle()
      const surface = layer.surfaces[0]!
      expect(surface.volume.left).toBe(100)

      // 购物袋打开时按钮被隐藏：浏览器读到的布局是空的（这里用偏到左边的位置模拟）。
      shown = false
      offsetLeft = -100
      sync()
      settle()
      expect(surface.flow?.active).toBe(false)

      shown = true
      offsetLeft = 0
      sync()
      expect(surface.flow?.active).toBe(false)
      expect(surface.volume.left).toBe(100)
    }
    finally { layer.dispose() }
  })

  it('关闭材质化的玻璃直接出现，移除时立即释放', async () => {
    const { layer, sync, element } = setup()
    try {
      element.dataset.glassMaterialize = 'none'
      await flush()
      sync()
      const surface = layer.surfaces[0]!
      expect(surface.materialize.value).toBe(1)
      element.remove()
      await flush()
      expect(layer.fading).toHaveLength(0)
      expect(surface.content).toBeNull()
    }
    finally {
      layer.dispose()
    }
  })
})
