import type { ExternalTexture, Scene, WebGPURenderer } from 'three/webgpu'
import type { ElementTexture } from '../gpu'
import type { GlassContentHandle } from './content-material'
import type { GlassTheme } from './defaults'
import type { VolumeSurface } from './fusion'
import type { GlassOptions } from './options'
import { Mesh, PlaneGeometry, Vector2 } from 'three/webgpu'
import { attr, GLASS_ATTR, GLASS_CLIP_ATTR, GLASS_FADE_ATTR, GLASS_MODAL_ATTR, GLASS_SCRIM_ATTR } from '../contract'
import { createElementTexture, disposeElementTexture, uploadElement } from '../gpu'
import { glassContentRenderOrder } from '../render-order'
import { reducedMotionQuery } from '../shared/motion'
import { advanceSpring } from '../shared/spring'
import { BackdropBlur } from './blur'
import { createGlassContent } from './content-material'
import { contentOccluders, createHtmlPaintOrderComparator } from './content-order'
import { ContentBackdrop } from './ContentBackdrop'
import { onGlassDefaultsChange } from './defaults'
import { glassOptionsSignature, parseGlassOptions } from './options'
import { GlassThemeSource } from './theme'
import { VolumeGroups } from './VolumeGroups'

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface GlassSurface {
  element: HTMLElement
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string
  material: GlassContentHandle
  mesh: Mesh
  /** 玻璃上 HTML 内容的快照。 */
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  lastGeometry: Rect | null
  dirty: boolean
  settleFrames: number
  /** 等待浏览器为这块玻璃生成新的绘制记录。 */
  paintPending: boolean
  /** 当前纹理是否曾在整块玻璃可见时上传。 */
  contentComplete: boolean
  /** 上一帧是否与视口相交。 */
  visible: boolean
  /** 上一帧是否完整位于视口与媒体裁剪区域内。 */
  fullyVisible: boolean
  addedDrawable: boolean
  resizeObserver: ResizeObserver | null
  retryTimer: number | null
  onScroll: () => void
  onTransitionEnd: () => void
}

export interface LiquidGlassLayerOptions {
  canvas: HTMLCanvasElement
  root: HTMLElement
  scene: Scene
  device: GPUDevice
  renderer: WebGPURenderer
  getBackdrop: () => ExternalTexture | null
  /** 固定主题；缺省时读取 `<html data-theme>`，再退回系统配色。 */
  theme?: GlassTheme | null
  onInvalidate: () => void
  onFault: (cause: unknown) => void
}

/** 反射取样在透射方差之上附加的粗糙度，需与体积着色器一致。 */
const REFLECTION_VARIANCE = 64

interface PaintEventLike extends Event {
  changedElements?: readonly Element[]
}

function intersects(rect: Rect, width: number, height: number): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > 0
    && rect.top + rect.height > 0
    && rect.left < width
    && rect.top < height
}

/** 用 offset 系列属性相对定位基准测量元素，不受元素自身 transform 影响。 */
function offsetRect(element: HTMLElement, base: HTMLElement): Rect {
  const rect = base.getBoundingClientRect()
  return {
    left: rect.left + element.offsetLeft - base.scrollLeft,
    top: rect.top + element.offsetTop - base.scrollTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }
}

function intersectsRect(rect: Rect, other: DOMRect): boolean {
  return rect.width > 0
    && rect.height > 0
    && rect.left + rect.width > other.left
    && rect.top + rect.height > other.top
    && rect.left < other.right
    && rect.top < other.bottom
}

function colorAlpha(value: string): number {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (!match?.[1])
    return 1
  const parts = match[1].split(',').map(part => Number.parseFloat(part))
  const alpha = parts.length === 4
    ? parts[3]
    : 1
  return alpha === undefined || !Number.isFinite(alpha)
    ? 1
    : Math.min(1, Math.max(0, alpha))
}

export class LiquidGlassLayer {
  private readonly canvas: HTMLCanvasElement
  private readonly root: HTMLElement
  private readonly scene: Scene
  private readonly device: GPUDevice
  private readonly renderer: WebGPURenderer
  private readonly getBackdrop: () => ExternalTexture | null
  private readonly onInvalidate: () => void
  private readonly onFault: (cause: unknown) => void
  private readonly surfaces = new Map<HTMLElement, GlassSurface>()
  private readonly geometry = new PlaneGeometry(1, 1)
  private readonly viewport = new Vector2(1, 1)
  private readonly paintToggle = new WeakSet<HTMLElement>()
  private pressed: HTMLElement | null = null
  private feedback = new Map<HTMLElement, { press: { value: number, velocity: number } }>()
  private animation = 0
  private previousTime = 0
  private reducedMotion: MediaQueryList | null = null
  private observer: MutationObserver | null = null
  private readonly themeSource: GlassThemeSource
  private stopDefaults: (() => void) | null = null
  private blur: BackdropBlur | null = null
  private volumes: VolumeGroups | null = null
  private contentBackdrop: ContentBackdrop | null = null
  private shadingScale = 1
  private shadingSplit = Infinity
  private started = false
  private disposed = false

  constructor(options: LiquidGlassLayerOptions) {
    this.canvas = options.canvas
    this.root = options.root
    this.scene = options.scene
    this.device = options.device
    this.renderer = options.renderer
    this.getBackdrop = options.getBackdrop
    this.themeSource = new GlassThemeSource(() => this.refreshAll(), options.theme ?? null)
    this.onInvalidate = options.onInvalidate
    this.onFault = options.onFault
  }

  start(): void {
    if (this.started || this.disposed)
      return
    if (typeof this.canvas.updateElementGeometry !== 'function' || typeof this.canvas.getElementImageDefaultSize !== 'function')
      return

    this.started = true
    this.viewport.set(this.canvas.clientWidth, this.canvas.clientHeight)
    this.observer = new MutationObserver(records => this.handleMutations(records))
    this.observer.observe(this.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.themeSource.start()
    this.stopDefaults = onGlassDefaultsChange(() => this.refreshAll())
    const backdrop = this.getBackdrop()
    if (backdrop) {
      this.blur = new BackdropBlur(this.renderer, backdrop)
      this.volumes = new VolumeGroups(this.scene, this.blur.textures, this.renderer)
      this.contentBackdrop = new ContentBackdrop(this.renderer, backdrop)
    }
    window.addEventListener('resize', this.handleWindowResize, { passive: true })
    this.root.addEventListener('pointerdown', this.handlePointer, { passive: true })
    this.root.addEventListener('pointerleave', this.handlePointerLeave)
    window.addEventListener('pointerup', this.handlePointerUp)
    window.addEventListener('pointercancel', this.handlePointerUp)
    window.addEventListener('blur', this.handlePointerLeave)
    this.reducedMotion = reducedMotionQuery()
    this.scan()
  }

  sync(event?: Event): void {
    if (!this.started || this.disposed)
      return
    this.viewport.set(this.canvas.clientWidth, this.canvas.clientHeight)
    if (this.viewport.x < 1 || this.viewport.y < 1)
      return

    const changed = (event as PaintEventLike | undefined)?.changedElements ?? []
    const modal = this.root.querySelector<HTMLElement>(attr(GLASS_MODAL_ATTR))
    const dimming = this.modalFactor(modal)
    let visibleSurfaces = 0
    let maxBlur = 0
    const volumeSurfaces: VolumeSurface[] = []
    const surfaceById = new Map<number, GlassSurface>()
    for (const surface of [
      ...this.surfaces.values(),
    ]) {
      if (!surface.element.isConnected) {
        this.unregister(surface)
        continue
      }

      const contentChanged = changed.some(element => surface.element.contains(element))
      if (contentChanged) {
        surface.paintPending = false
        surface.dirty = true
        if (surface.retryTimer !== null) {
          window.clearTimeout(surface.retryTimer)
          surface.retryTimer = null
        }
      }

      const rect = this.measure(surface)

      const anchorRect = surface.anchor?.isConnected
        ? surface.anchor.getBoundingClientRect()
        : null
      const style = getComputedStyle(surface.element)
      const visible = style.visibility !== 'hidden' && style.display !== 'none'
        && surface.element.getClientRects().length > 0
        && intersects(rect, this.viewport.x, this.viewport.y)
        && (!anchorRect || intersectsRect(rect, anchorRect))
      const clip = surface.element.closest<HTMLElement>(attr(GLASS_CLIP_ATTR))?.getBoundingClientRect()
      const fullyVisible = visible && rect.left >= Math.max(0, clip?.left ?? 0)
        && rect.top >= Math.max(0, clip?.top ?? 0)
        && rect.left + rect.width <= Math.min(this.viewport.x, clip?.right ?? this.viewport.x) + 0.5
        && rect.top + rect.height <= Math.min(this.viewport.y, clip?.bottom ?? this.viewport.y) + 0.5
      const size = this.textureSize(surface)
      if (visible && (size.width !== surface.textureWidth || size.height !== surface.textureHeight))
        this.resizeSurface(surface, size.width, size.height)
      if (visible) {
        visibleSurfaces++
        maxBlur = Math.max(maxBlur, surface.options.blur)
      }
      if (visible && (!surface.visible || (fullyVisible && !surface.fullyVisible))) {
        this.kickPaint(surface)
        surface.dirty = true
        surface.settleFrames = 4
      }
      if (visible && !surface.contentComplete && surface.lastGeometry
        && (rect.left !== surface.lastGeometry.left || rect.top !== surface.lastGeometry.top)) {
        surface.dirty = true
        if (!contentChanged && !surface.paintPending)
          this.kickPaint(surface)
      }
      surface.visible = visible
      surface.fullyVisible = fullyVisible
      surface.mesh.visible = visible
      this.placeSurface(surface, rect)
      // 只有明确要求裁剪的媒体区域才限制玻璃，普通定位父元素允许阴影溢出。
      surface.material.setClip(clip?.left ?? 0, clip?.top ?? 0, clip?.right ?? this.viewport.x, clip?.bottom ?? this.viewport.y)
      const feedback = this.feedback.get(surface.element)
      this.updateGeometry(surface, rect)
      const opacity = this.pageOpacity(surface.element)
      const brightness = modal?.contains(surface.element)
        ? 1
        : dimming
      surface.material.setOpacity(opacity * brightness)
      if (visible) {
        surfaceById.set(surface.mesh.id, surface)
        volumeSurfaces.push({
          id: surface.mesh.id,
          ...rect,
          options: surface.options,
          clip: [
            clip?.left ?? -100000,
            clip?.top ?? -100000,
            clip?.right ?? 100000,
            clip?.bottom ?? 100000,
          ],
          opacity,
          brightness,
          paintOrder: 0,
          press: feedback?.press.value ?? 0,
        })
      }

      // 有完整快照时保留离屏部分；首次只有部分可见时也要上传，否则文字会一直为空。
      const canUpload = visible && (fullyVisible || !surface.contentComplete || contentChanged)
      if (canUpload && !surface.paintPending && (surface.dirty || surface.settleFrames > 0)) {
        if (this.upload(surface)) {
          surface.contentComplete = fullyVisible
          surface.settleFrames = Math.max(0, surface.settleFrames - 1)
        }
        else {
          surface.settleFrames = 0
        }
      }
      if (canUpload && !surface.paintPending && surface.settleFrames > 0)
        this.onInvalidate()
    }

    const backdrop = this.getBackdrop()
    if (backdrop) {
      const comparePaintOrder = createHtmlPaintOrderComparator()
      volumeSurfaces.sort((a, b) => a.options.layer - b.options.layer
        || comparePaintOrder(surfaceById.get(a.id)!.element, surfaceById.get(b.id)!.element))
      const overlays: Parameters<ContentBackdrop['render']>[1] = []
      volumeSurfaces.forEach((volume, index) => {
        volume.paintOrder = index / (volumeSurfaces.length + 1)
        const surface = surfaceById.get(volume.id)!
        const occluders = contentOccluders(volume, volumeSurfaces.slice(index + 1))
        surface.material.setOccluders(occluders)
        surface.mesh.renderOrder = glassContentRenderOrder(volume.options.layer, volume.paintOrder)
        if (occluders.length)
          overlays.push({ mesh: surface.mesh, material: surface.material.occludedMaterial })
      })
      const composed = this.contentBackdrop?.render(backdrop, overlays, this.viewport.x, this.viewport.y) ?? backdrop
      if (this.blur && visibleSurfaces > 0)
        this.blur.render(composed, this.viewport.x, this.viewport.y, maxBlur * maxBlur + REFLECTION_VARIANCE)
      this.volumes?.sync(volumeSurfaces, this.viewport, composed, {
        scale: this.shadingScale,
        pixelWidth: this.canvas.width,
        pixelHeight: this.canvas.height,
        cssWidth: this.viewport.x,
        cssHeight: this.viewport.y,
        split: this.shadingSplit,
      })
    }
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    cancelAnimationFrame(this.animation)
    this.root.removeEventListener('pointerdown', this.handlePointer)
    this.root.removeEventListener('pointerleave', this.handlePointerLeave)
    window.removeEventListener('pointerup', this.handlePointerUp)
    window.removeEventListener('pointercancel', this.handlePointerUp)
    window.removeEventListener('blur', this.handlePointerLeave)
    this.feedback.clear()
    this.observer?.disconnect()
    this.observer = null
    this.themeSource.stop()
    this.stopDefaults?.()
    this.stopDefaults = null
    window.removeEventListener('resize', this.handleWindowResize)
    for (const surface of [
      ...this.surfaces.values(),
    ])
      this.unregister(surface)
    this.surfaces.clear()
    this.contentBackdrop?.dispose()
    this.contentBackdrop = null
    this.volumes?.dispose()
    this.volumes = null
    this.blur?.dispose()
    this.blur = null
    this.geometry.dispose()
  }

  /** 固定主题，传入 null 恢复跟随页面。 */
  setTheme(theme: GlassTheme | null): void {
    this.themeSource.set(theme)
  }

  /**
   * 设置玻璃体积的着色比例，下一次 `sync()` 生效。
   *
   * `split` 是场景中插在玻璃之间的其他内容的绘制顺序，降低分辨率时体积组在这里分成两段分别合成。
   */
  setShading(scale: number, split: number): void {
    this.shadingScale = scale
    this.shadingSplit = split
  }

  /** 从实际命中的 HTML 控件取得交互目标，键盘焦点由浏览器绘制。 */
  private readonly handlePointer = (event: PointerEvent): void => {
    this.pressed = event.target instanceof Element
      ? event.target.closest<HTMLElement>(attr(GLASS_ATTR))
      : null
    this.startFeedback()
    this.onInvalidate()
  }

  private readonly handlePointerUp = (): void => {
    this.pressed = null
    this.startFeedback()
  }

  private readonly handlePointerLeave = (): void => {
    this.pressed = null
    this.startFeedback()
  }

  /** 交互结束且弹簧静止后停止请求帧，静态页面无需持续重绘。 */
  private startFeedback(): void {
    if (this.animation || this.disposed)
      return
    this.previousTime = performance.now()
    this.animation = requestAnimationFrame(this.animateFeedback)
  }

  private readonly animateFeedback = (now: number): void => {
    let moving = false
    for (const [element, feedback] of this.feedback) {
      const press = element === this.pressed && !this.reducedMotion?.matches
        ? 1
        : 0
      moving = advanceSpring(feedback.press, press, (now - this.previousTime) / 1000) || moving
    }
    this.previousTime = now
    this.onInvalidate()
    this.animation = moving
      ? requestAnimationFrame(this.animateFeedback)
      : 0
  }

  private scan(): void {
    for (const element of this.root.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
      this.register(element)
  }

  private register(element: HTMLElement): void {
    if (this.surfaces.has(element) || !element.isConnected || !this.root.contains(element))
      return
    if (element.parentElement?.closest(attr(GLASS_ATTR)))
      return

    const options = parseGlassOptions(element, this.theme())
    const anchor = this.resolveAnchor(element, options)
    const initial = this.domMeasure(element, anchor)
    if (!initial.width || !initial.height)
      return

    const backdrop = this.getBackdrop()
    const blur = this.blur
    if (!backdrop || !blur)
      return

    const size = this.textureSize(element)
    const content = this.createContentTexture(size.width, size.height)
    if (!content)
      return

    const addedDrawable = !element.hasAttribute('drawable')
    if (addedDrawable)
      element.setAttribute('drawable', '')

    this.canvas.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix().translate(initial.left, initial.top),
    })

    const material = createGlassContent(content.external)
    const mesh = new Mesh(this.geometry, material.material)
    mesh.frustumCulled = false
    // 绘制顺序在每帧 sync() 中按层级与 HTML 绘制顺序设置。
    mesh.visible = false
    this.scene.add(mesh)

    const surface: GlassSurface = {
      element,
      anchor,
      options,
      signature: glassOptionsSignature(options),
      material,
      mesh,
      content,
      textureWidth: size.width,
      textureHeight: size.height,
      lastGeometry: null,
      dirty: true,
      settleFrames: 4,
      paintPending: false,
      contentComplete: false,
      visible: false,
      fullyVisible: false,
      addedDrawable,
      resizeObserver: null,
      retryTimer: null,
      onScroll: () => {
        surface.dirty = true
        this.onInvalidate()
      },
      onTransitionEnd: () => {
        surface.dirty = true
        this.onInvalidate()
      },
    }

    surface.resizeObserver = new ResizeObserver(() => {
      surface.dirty = true
      this.onInvalidate()
    })
    surface.resizeObserver.observe(element)
    element.addEventListener('scroll', surface.onScroll, { capture: true, passive: true })
    element.addEventListener('transitionend', surface.onTransitionEnd)

    this.feedback.set(element, {
      press: { value: 0, velocity: 0 },
    })
    this.surfaces.set(element, surface)
    this.placeSurface(surface, initial)
    this.updateGeometry(surface, initial)
    this.onInvalidate()
  }

  private unregister(surface: GlassSurface): void {
    if (!this.surfaces.has(surface.element))
      return
    this.surfaces.delete(surface.element)
    this.feedback.delete(surface.element)
    surface.resizeObserver?.disconnect()
    if (surface.retryTimer !== null) {
      window.clearTimeout(surface.retryTimer)
      surface.retryTimer = null
    }
    surface.element.removeEventListener('scroll', surface.onScroll, { capture: true })
    surface.element.removeEventListener('transitionend', surface.onTransitionEnd)
    if (typeof this.canvas.clearElementGeometry === 'function')
      this.canvas.clearElementGeometry(surface.element)
    if (surface.addedDrawable)
      surface.element.removeAttribute('drawable')
    // kickPaint 写入的透明阴影只用于触发重绘，退出时还原，避免遮住样式表中的阴影。
    if (this.paintToggle.delete(surface.element) || surface.element.style.boxShadow.includes('rgba(0, 0, 0, 0)'))
      surface.element.style.boxShadow = ''
    this.scene.remove(surface.mesh)
    surface.material.dispose()
    disposeElementTexture(surface.content)
    surface.content = null
    this.onInvalidate()
  }

  private readonly handleWindowResize = (): void => {
    this.scan()
    for (const surface of this.surfaces.values()) {
      this.kickPaint(surface)
      surface.dirty = true
      surface.settleFrames = 4
    }
    this.onInvalidate()
  }

  private handleMutations(records: MutationRecord[]): void {
    let invalidated = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as HTMLElement
        const name = record.attributeName ?? ''
        if (name === GLASS_ATTR) {
          if (target.hasAttribute(GLASS_ATTR)) {
            this.register(target)
          }
          else {
            const surface = this.surfaces.get(target)
            if (surface)
              this.unregister(surface)
          }
          invalidated = true
          continue
        }
        if (name.startsWith('data-glass-')) {
          const surface = this.surfaces.get(target) ?? this.surfaceOwner(target)
          if (surface)
            this.refresh(surface)
          invalidated = true
          continue
        }
        const surface = this.surfaceOwner(target)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
        else {
          const glass = target.closest<HTMLElement>(attr(GLASS_ATTR))
          if (glass && !this.surfaces.has(glass))
            this.register(glass)
        }
        continue
      }

      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement)
            this.registerWithin(node)
        }
        const surface = this.surfaceOwner(record.target as HTMLElement)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
        else if (record.addedNodes.length || record.removedNodes.length) {
          invalidated = true
        }
        continue
      }

      if (record.type === 'characterData') {
        const surface = this.surfaceOwner(record.target.parentElement)
        if (surface) {
          surface.dirty = true
          invalidated = true
        }
      }
    }
    if (invalidated)
      this.onInvalidate()
  }

  private registerWithin(node: HTMLElement): void {
    if (node.matches(attr(GLASS_ATTR)))
      this.register(node)
    for (const element of node.querySelectorAll<HTMLElement>(attr(GLASS_ATTR)))
      this.register(element)
  }

  private surfaceOwner(element: HTMLElement | null): GlassSurface | null {
    let current = element
    while (current) {
      const surface = this.surfaces.get(current)
      if (surface)
        return surface
      current = current.parentElement
    }
    return null
  }

  private refresh(surface: GlassSurface): void {
    const options = parseGlassOptions(surface.element, this.theme())
    const signature = glassOptionsSignature(options)
    if (signature === surface.signature)
      return
    surface.options = options
    surface.signature = signature
    surface.anchor = this.resolveAnchor(surface.element, options)
    surface.dirty = true
    this.onInvalidate()
  }

  private refreshAll(): void {
    for (const surface of this.surfaces.values())
      this.refresh(surface)
  }

  private resolveAnchor(element: HTMLElement, options: GlassOptions): HTMLElement | null {
    if (options.anchor) {
      try {
        const anchor = document.querySelector<HTMLElement>(options.anchor)
        if (anchor && !element.contains(anchor))
          return anchor
      }
      catch {}
    }
    const parent = element.offsetParent
    return parent instanceof HTMLElement
      ? parent
      : null
  }

  private domMeasure(element: HTMLElement, anchor: HTMLElement | null): Rect {
    if (anchor)
      return offsetRect(element, anchor)
    const rect = element.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
  }

  private measure(surface: GlassSurface): Rect {
    const element = surface.element
    const anchor = surface.anchor
    if (anchor?.isConnected)
      return offsetRect(element, anchor)
    const parent = element.offsetParent
    if (parent instanceof HTMLElement)
      return offsetRect(element, parent)
    return {
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    }
  }

  private placeSurface(surface: GlassSurface, rect: Rect): void {
    if (this.viewport.x < 1 || this.viewport.y < 1)
      return
    const padding = Math.max(surface.options.shadowSize, 0) + 2
    const left = rect.left - padding
    const top = rect.top - padding
    const width = rect.width + padding * 2
    const height = rect.height + padding * 2
    surface.mesh.position.set(
      ((left + width / 2) / this.viewport.x) * 2 - 1,
      1 - ((top + height / 2) / this.viewport.y) * 2,
      0,
    )
    surface.mesh.scale.set(
      (width / this.viewport.x) * 2,
      (height / this.viewport.y) * 2,
      1,
    )
    surface.material.setPanel(
      new Vector2(rect.width, rect.height),
      new Vector2(width, height),
      this.viewport,
    )
  }

  private updateGeometry(surface: GlassSurface, rect: Rect): void {
    const last = surface.lastGeometry
    if (last
      && Math.abs(last.left - rect.left) < 0.05
      && Math.abs(last.top - rect.top) < 0.05
      && Math.abs(last.width - rect.width) < 0.05
      && Math.abs(last.height - rect.height) < 0.05) {
      return
    }
    this.canvas.updateElementGeometry(surface.element, {
      canvasTransform: new DOMMatrix().translate(rect.left, rect.top),
    })
    surface.lastGeometry = rect
  }

  /** 强制浏览器更新嵌套 drawable 快照，供首次可见和尺寸变化后使用。 */
  private kickPaint(surface: GlassSurface): void {
    const element = surface.element
    surface.paintPending = true
    const alternate = !this.paintToggle.has(element)
    if (alternate)
      this.paintToggle.add(element)
    else
      this.paintToggle.delete(element)
    // 两个完全透明的阴影交替，重复进入视口也会触发新的绘制记录。
    element.style.boxShadow = `${alternate ? 0.001 : 0}px 0 0 1px rgba(0, 0, 0, 0)`
    this.scheduleRetry(surface)
    this.onInvalidate()
  }

  /** 模态层外玻璃的亮度比例；没有模态层时为 1。 */
  private modalFactor(modal: HTMLElement | null): number {
    const scrim = modal?.querySelector<HTMLElement>(attr(GLASS_SCRIM_ATTR))
    if (!modal || !scrim)
      return 1
    const shellOpacity = Number.parseFloat(getComputedStyle(modal).opacity)
    const opacity = Number.isFinite(shellOpacity)
      ? shellOpacity
      : 1
    return 1 - colorAlpha(getComputedStyle(scrim).backgroundColor) * opacity
  }

  private pageOpacity(element: HTMLElement): number {
    const page = element.closest(attr(GLASS_FADE_ATTR))
    if (!(page instanceof HTMLElement))
      return 1
    const opacity = Number.parseFloat(getComputedStyle(page).opacity)
    return Number.isFinite(opacity)
      ? opacity
      : 1
  }

  private textureSize(surfaceOrElement: GlassSurface | HTMLElement): { width: number, height: number } {
    const element = surfaceOrElement instanceof HTMLElement
      ? surfaceOrElement
      : surfaceOrElement.element
    try {
      const size = this.canvas.getElementImageDefaultSize(element)
      if (size.width >= 1 && size.height >= 1) {
        return {
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
        }
      }
    }
    catch {}
    const dpr = typeof window === 'undefined'
      ? 1
      : window.devicePixelRatio || 1
    return {
      width: Math.max(1, Math.ceil(element.offsetWidth * dpr)),
      height: Math.max(1, Math.ceil(element.offsetHeight * dpr)),
    }
  }

  private createContentTexture(width: number, height: number): ElementTexture | null {
    try {
      return createElementTexture(this.device, width, height)
    }
    catch (cause) {
      this.onFault(cause)
      return null
    }
  }

  private resizeSurface(surface: GlassSurface, width: number, height: number): void {
    const content = this.createContentTexture(width, height)
    if (!content)
      return
    surface.material.setContent(content.external)
    disposeElementTexture(surface.content)
    surface.content = content
    surface.textureWidth = width
    surface.textureHeight = height
    surface.dirty = true
    surface.contentComplete = false
    surface.settleFrames = 4
    this.kickPaint(surface)
  }

  private upload(surface: GlassSurface): boolean {
    if (!surface.content)
      return false
    try {
      uploadElement(this.device, surface.element, surface.content.texture)
      surface.dirty = false
      return true
    }
    catch {
      surface.dirty = false
      this.scheduleRetry(surface)
      return false
    }
  }

  private scheduleRetry(surface: GlassSurface): void {
    if (surface.retryTimer !== null)
      return
    surface.retryTimer = window.setTimeout(() => {
      surface.retryTimer = null
      if (!this.surfaces.has(surface.element))
        return
      surface.dirty = true
      if (surface.visible)
        this.kickPaint(surface)
    }, 180)
  }

  private theme(): GlassTheme {
    return this.themeSource.value
  }
}
