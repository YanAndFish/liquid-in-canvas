import type { GlassSurface } from '../../src/liquid-glass/surface'
import type { VolumeGroupPlan } from '../../src/liquid-glass/VolumeGroups.hot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrawList } from '../../src/frame.hot'
import { createElementTexture } from '../../src/gpu'
import { LiquidGlassLayer } from '../../src/liquid-glass/LiquidGlassLayer'
import { VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from '../../src/liquid-glass/volume-shader'
import { writeVolumeGroup } from '../../src/liquid-glass/VolumeGroups.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

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
    paint: () => sync(Object.assign(new Event('paint'), {
      changedElements: [element],
    })),
  }
}

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
      expect(moved.volume.left).toBeLessThan(150)
      expect(layer.surfaces.some(surface => surface.element === first)).toBe(false)
    }
    finally { layer.dispose() }
  })

  for (const order of ['旧按钮先注销', '新按钮先注册'] as const) {
    it(`激活玻璃换到另一个按钮的那一帧仍然绘制完整的体积（${order}）`, async () => {
      const { layer, element, anchor, sync } = setup()
      const frame = (layer as unknown as {
        frame: {
          advanceMotion: (seconds: number, pressed: HTMLElement | null, reduced: boolean) => boolean
          volumes: { groups: { planOf: (surface: unknown) => VolumeGroupPlan | null } }
        }
      }).frame
      const drawnOpacity = (surface: GlassSurface) => {
        const plan = frame.volumes.groups.planOf(surface.volume)
        if (!plan)
          return 0
        const data = new Float32Array(VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS * plan.count)
        writeVolumeGroup(data, 0, plan)
        const index = plan.members.indexOf(surface.volume)
        return data[VOLUME_GROUP_FLOATS + VOLUME_MEMBER_FLOATS * index + 23]!
      }
      try {
        const first = nestedButton(element, anchor, 6)
        const second = nestedButton(element, anchor, 90)
        first.dataset.liquidGlass = ''
        first.dataset.glassMorph = 'tabs'
        await flush()
        sync()
        for (let steps = 0; steps < 240 && frame.advanceMotion(1 / 60, null, false); steps++)
          sync()
        const before = layer.surfaces.find(surface => surface.element === first)!
        expect(before.materialize.value).toBe(1)
        expect(drawnOpacity(before)).toBe(1)

        if (order === '旧按钮先注销') {
          delete first.dataset.liquidGlass
          second.dataset.glassMorph = 'tabs'
          second.dataset.liquidGlass = ''
        }
        else {
          second.dataset.glassMorph = 'tabs'
          second.dataset.liquidGlass = ''
          delete first.dataset.liquidGlass
        }
        await flush()
        sync()
        const moved = layer.surfaces.find(surface => surface.element === second)!
        expect(layer.surfaces.some(surface => surface.element === first)).toBe(false)
        expect(moved.flow?.active).toBe(true)
        expect(moved.volume.left).toBeLessThan(150)
        expect(moved.materialize.value).toBe(1)
        expect(drawnOpacity(moved)).toBe(1)

        for (let steps = 0; steps < 240 && frame.advanceMotion(1 / 60, null, false); steps++) {
          sync()
          expect(drawnOpacity(moved)).toBeGreaterThan(0.99)
        }
        sync()
        expect(moved.flow?.active).toBe(false)
        expect(moved.volume.left).toBe(190)
        expect(drawnOpacity(moved)).toBe(1)
      }
      finally { layer.dispose() }
    })
  }

  it('data-glass-morph-from 的玻璃从来源靠近自己的一侧分出来，连接随迁移断开；移除后流回来源并被吸收', async () => {
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
      panel.dataset.glassMorph = 'pop-panel'
      panel.dataset.glassMorphFrom = 'pop'
      await flush()
      sync()
      const grown = layer.surfaces.find(surface => surface.element === panel)!
      expect(grown.partner).toBe(source)
      expect(grown.flow?.active).toBe(true)
      expect(grown.volume.left).toBeGreaterThanOrEqual(source.volume.left)
      expect(grown.volume.left + grown.volume.width).toBeLessThanOrEqual(source.volume.left + source.volume.width + 0.5)
      expect(grown.volume.width).toBeLessThan(15)
      expect(grown.volume.left + grown.volume.width).toBeCloseTo(source.volume.left + source.volume.width, 0)
      expect(grown.volume.link).toBe(source.volume)
      expect(grown.volume.linkFusion).toBeGreaterThan(0)
      expect(grown.volume.fusion).toBe(grown.options.fusion)
      expect(grown.materialize.value).toBe(1)
      expect(grown.revealGrowing).toBe(true)
      expect(layer.ghosts).toHaveLength(0)
      let linked = 0
      for (let frame = 0; frame < 120; frame++) {
        advance(1 / 60)
        sync()
        linked = grown.volume.link ? frame : linked
      }
      expect(linked).toBeGreaterThan(2)
      expect(grown.flow?.active).toBe(false)
      expect(grown.partner).toBeNull()
      expect(grown.volume.link).toBeNull()
      expect(grown.volume.fusion).toBe(grown.options.fusion)

      delete panel.dataset.liquidGlass
      await flush()
      sync()
      expect(layer.ghosts).toHaveLength(1)
      expect(layer.ghosts[0]!.target).toBe(source)
      expect(layer.ghosts[0]!.partner).toBeNull()
      const ghost = layer.ghosts[0]!.volume
      expect(ghost.left).toBeGreaterThan(150)
      expect(ghost.link).toBe(source.volume)
      for (let frame = 0; frame < 240 && layer.ghosts.length > 0; frame++) {
        advance(1 / 60)
        sync()
      }
      expect(layer.ghosts).toHaveLength(0)
    }
    finally { layer.dispose() }
  })

  it('首次显现期间与图片、字体加载引起的布局变化直接到位，应用自己的改动仍然流动', async () => {
    const { layer, element, sync } = setup()
    const frame = (layer as unknown as { frame: { advanceMotion: (s: number, p: null, r: boolean) => boolean } }).frame
    const settle = () => {
      for (let steps = 0; steps < 240 && frame.advanceMotion(1 / 60, null, false); steps++)
        sync()
    }
    const place = (top: number) => {
      Object.defineProperty(element, 'offsetTop', { value: top, configurable: true })
      element.getClientRects = () => [
        new DOMRect(100, 100 + top, 160, 60),
      ] as unknown as DOMRectList
    }
    try {
      element.dataset.glassMorph = ''
      await flush()
      sync()
      const surface = layer.surfaces[0]!
      frame.advanceMotion(1 / 60, null, false)
      sync()
      expect(surface.reveal).toBeLessThan(1)
      place(40)
      sync()
      expect(surface.flow?.active).toBe(false)
      expect(surface.volume.top).toBe(140)
      settle()
      expect(surface.reveal).toBe(1)

      const image = document.createElement('img')
      element.parentElement!.append(image)
      await flush()
      image.dispatchEvent(new Event('load'))
      place(90)
      sync()
      expect(surface.flow?.active).toBe(false)
      expect(surface.volume.top).toBe(190)

      element.parentElement!.dataset.state = 'moved'
      await flush()
      place(10)
      sync()
      expect(surface.flow?.active).toBe(true)
    }
    finally { layer.dispose() }
  })

  it('同名玻璃仍在页面上时不交接：新玻璃按普通玻璃出现', async () => {
    const { layer, element, anchor, sync } = setup()
    try {
      const button = nestedButton(element, anchor, 6)
      const other = nestedButton(element, anchor, 90)
      button.dataset.liquidGlass = ''
      button.dataset.glassMorph = 'pop'
      await flush()
      sync()
      other.dataset.liquidGlass = ''
      other.dataset.glassMorph = 'pop'
      await flush()
      sync()
      const appeared = layer.surfaces.find(surface => surface.element === other)!
      expect(appeared.partner).toBeNull()
      expect(appeared.flow?.active).toBe(false)
      expect(appeared.volume.left).toBe(190)
    }
    finally { layer.dispose() }
  })

  it('来源按列表顺序取第一块在场的，名字先在最近的作用域里查找', async () => {
    const { layer, element, anchor, sync } = setup()
    try {
      const scope = document.createElement('div')
      scope.dataset.glassScope = ''
      element.append(scope)
      const outer = nestedButton(element, anchor, 6)
      const inner = nestedButton(scope, anchor, 70)
      const target = nestedButton(scope, anchor, 140)
      outer.dataset.liquidGlass = ''
      outer.dataset.glassMorph = 'row'
      inner.dataset.liquidGlass = ''
      inner.dataset.glassMorph = 'row'
      await flush()
      sync()
      const near = layer.surfaces.find(surface => surface.element === inner)!

      target.dataset.liquidGlass = ''
      target.dataset.glassMorphFrom = 'missing row'
      await flush()
      sync()
      const grown = layer.surfaces.find(surface => surface.element === target)!
      expect(grown.options.morph).toBe('')
      expect(grown.partner).toBe(near)
    }
    finally { layer.dispose() }
  })

  it('移除时按 data-glass-morph-to 并入在场的玻璃；没有在场的目标时在原处退去', async () => {
    const { layer, element, anchor, sync } = setup()
    try {
      const keep = nestedButton(element, anchor, 6)
      const leave = nestedButton(element, anchor, 90)
      keep.dataset.liquidGlass = ''
      keep.dataset.glassMorph = 'clear'
      leave.dataset.liquidGlass = ''
      leave.dataset.glassMorph = 'submit'
      leave.dataset.glassMorphTo = 'missing clear'
      await flush()
      sync()
      sync()
      const target = layer.surfaces.find(surface => surface.element === keep)!
      leave.remove()
      await flush()
      sync()
      expect(layer.ghosts).toHaveLength(1)
      expect(layer.ghosts[0]!.target).toBe(target)

      layer.ghosts.length = 0
      keep.dataset.glassMorphTo = 'submit'
      await flush()
      sync()
      sync()
      keep.remove()
      await flush()
      sync()
      expect(layer.ghosts).toHaveLength(0)
    }
    finally { layer.dispose() }
  })

  it('跨层分出时在新玻璃所在的层留一段连接，连接流回来源', async () => {
    const { layer, element, anchor, sync } = setup()
    try {
      const button = nestedButton(element, anchor, 6)
      button.dataset.liquidGlass = ''
      button.dataset.glassMorph = 'trigger'
      await flush()
      sync()
      sync()
      const source = layer.surfaces.find(surface => surface.element === button)!
      const card = document.createElement('div')
      card.dataset.liquidGlass = ''
      card.dataset.glassLayer = '2'
      card.dataset.glassMorphFrom = 'trigger'
      Object.defineProperties(card, {
        offsetParent: {
          get: () => anchor,
        },
        offsetLeft: { value: 0 },
        offsetTop: { value: 30 },
        offsetWidth: { value: 160 },
        offsetHeight: { value: 30 },
      })
      card.getClientRects = () => [
        new DOMRect(100, 130, 160, 30),
      ] as unknown as DOMRectList
      anchor.append(card)
      await flush()
      sync()
      const grown = layer.surfaces.find(surface => surface.element === card)!
      expect(grown.partner).toBe(source)
      expect(layer.ghosts).toHaveLength(1)
      const bridge = layer.ghosts[0]!
      expect(bridge.target).toBe(source)
      expect(bridge.partner).toBe(grown)
      expect(bridge.volume.layer).toBe(2)
      expect(bridge.volume.link).toBe(grown.volume)
      expect(bridge.volume.options).toBe(source.options)
    }
    finally { layer.dispose() }
  })

  it('启动时已经在页面上的玻璃直接到位，不从来源分出', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    const { layer, sync, element } = setup()
    try {
      sync()
      expect(layer.surfaces[0]!.element).toBe(element)
      expect(layer.surfaces[0]!.pending).toBe(false)
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
      expect(surface.reveal).toBe(1)
      sync()
      expect(surface.contentBlur).toBe(0)
      expect(surface.contentScale).toBe(1)

      element.remove()
      await flush()
      expect(layer.surfaces).toHaveLength(0)
      expect(layer.fading).toEqual([surface])
      const texture = surface.content!.texture
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
  it('data-liquid-glass="false" 注销玻璃，改回来时重新注册', async () => {
    const { layer, sync, element } = setup()
    try {
      sync()
      expect(layer.surfaces.map(surface => surface.element)).toContain(element)
      element.dataset.liquidGlass = 'false'
      await flush()
      expect(layer.surfaces.map(surface => surface.element)).not.toContain(element)
      element.dataset.liquidGlass = 'true'
      await flush()
      expect(layer.surfaces.map(surface => surface.element)).toContain(element)
    }
    finally {
      layer.dispose()
    }
  })

  it('作用域上的参数变化时刷新其中的玻璃', async () => {
    const { layer, sync, element, anchor } = setup()
    try {
      anchor.dataset.glassScope = ''
      anchor.dataset.glassBlur = '6'
      await flush()
      sync()
      expect(layer.surfaces[0]!.options.blur).toBe(6)
      anchor.dataset.glassBlur = '30'
      await flush()
      expect(layer.surfaces[0]!.options.blur).toBe(30)
      element.dataset.glassBlur = '2'
      await flush()
      expect(layer.surfaces[0]!.options.blur).toBe(2)
    }
    finally {
      layer.dispose()
    }
  })
  it.each(['static', 'clip', 'follow'] as const)('液体迁移期间内容按 data-glass-morph-content="%s" 绘制', async (mode) => {
    const { layer, sync, element, anchor } = setup()
    const frame = (layer as unknown as { frame: { advanceMotion: (seconds: number, pressed: HTMLElement | null, reduced: boolean) => boolean } }).frame
    let offsetLeft = 0
    Object.defineProperty(element, 'offsetLeft', {
      get: () => offsetLeft,
      configurable: true,
    })
    anchor.getBoundingClientRect = () => new DOMRect(100, 100, 600, 60)
    try {
      element.dataset.glassMorph = ''
      element.dataset.glassMorphContent = mode
      await flush()
      sync()
      for (let steps = 0; steps < 240 && frame.advanceMotion(1 / 60, null, false); steps++)
        sync()
      const surface = layer.surfaces[0]!
      expect(surface.contentRect).toEqual(surface.rect)

      offsetLeft = 200
      sync()
      for (let steps = 0; steps < 3; steps++) {
        frame.advanceMotion(1 / 60, null, false)
        sync()
      }
      expect(surface.flow?.active).toBe(true)
      const { volume, rect, contentRect, contentClip } = surface
      expect(volume.left).not.toBe(rect.left)
      if (mode === 'follow') {
        expect(contentRect.left).toBe(volume.left)
        expect(contentRect.width).toBe(volume.width)
      }
      else {
        expect(contentRect).toEqual(rect)
      }
      if (mode === 'clip') {
        expect(contentClip[0]).toBeCloseTo(Math.max(0, volume.left))
        expect(contentClip[2]).toBeCloseTo(volume.left + volume.width)
      }
      else {
        expect(contentClip).toEqual([0, 0, 800, 600])
      }
    }
    finally { layer.dispose() }
  })
})

describe('放到玻璃之下的元素', () => {
  it('不进玻璃的内容快照：单独上传，画在同层体积之下，并写进页面背景；改回 above 后还原', async () => {
    const { layer, upload, element, paint, sync } = setup()
    try {
      const picture = document.createElement('div')
      picture.setAttribute('data-glass-place', 'below')
      Object.defineProperties(picture, {
        offsetParent: {
          get: () => element,
        },
        offsetLeft: { value: 10 },
        offsetTop: { value: 5 },
        offsetWidth: { value: 80 },
        offsetHeight: { value: 40 },
      })
      picture.getClientRects = () => [
        new DOMRect(110, 105, 80, 40),
      ] as unknown as DOMRectList
      element.append(picture)
      paint()
      expect(picture.hasAttribute('drawable')).toBe(true)
      const sources: Element[] = []
      upload.mockImplementation((source: { source: Element }) => {
        sources.push(source.source)
      })
      const items = sync(Object.assign(new Event('paint'), {
        changedElements: [picture],
      }))
      expect(sources).toContain(picture)
      expect(items).toBeGreaterThan(0)

      picture.setAttribute('data-glass-place', 'above')
      await flush()
      sync()
      expect(picture.hasAttribute('drawable')).toBe(false)
    }
    finally {
      layer.dispose()
    }
  })
})
