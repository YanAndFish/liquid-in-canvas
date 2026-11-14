/**
 * 一块玻璃在舞台中的状态，以及每帧代码在少见情况下调用的 DOM 辅助函数。
 *
 * 每帧测量与绘制用到的对象（矩形、体积、遮挡列表）在注册时创建，之后由 `glass-frame.hot.ts`
 * 每帧改写字段，不再分配。
 */
import type { ElementTexture } from '../gpu'
import type { SpringState } from '../shared/spring.hot'
import type { ContentSource } from './content.hot'
import type { LiquidFlow } from './flow.hot'
import type { VolumeSurface } from './fusion.hot'
import type { GlassOptions } from './options'
import { attr, GLASS_SCRIM_ATTR } from '../contract'

/** 视口或布局坐标中的矩形，单位为 CSS 像素。 */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 一块玻璃的全部状态。 */
export interface GlassSurface extends ContentSource {
  /** 生命周期内稳定的表面编号。 */
  readonly id: number
  readonly element: HTMLElement
  /**
   * 嵌套玻璃所在的外层玻璃，顶层玻璃为 null。
   *
   * 嵌套玻璃只有体积：它的 HTML 已经包含在外层的内容快照里。体积画在外层体积之上、
   * 外层内容之下，不遮挡外层的文字。
   */
  readonly host: GlassSurface | null
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string

  /** 液体迁移的弹簧；没有声明 `data-glass-morph` 时为 null。 */
  flow: LiquidFlow | null
  /** 下一帧直接把体积放到元素位置，不经过流动，例如窗口尺寸变化或首次测量。 */
  snapFlow: boolean
  /** 体积已经交给另一块同名玻璃，注销时不再留下起点。每帧开始时清除：仍然在页面上就不算交出。 */
  handedOver: boolean
  /**
   * 这块玻璃从哪块仍在页面上的同名玻璃里流出来。流动期间两者之间的融合距离随中心距离渐进，
   * 刚出现时不会让两块玻璃一起鼓起；流动结束后清空。
   */
  partner: GlassSurface | null

  /** 玻璃上 HTML 内容的快照；嵌套玻璃没有快照。 */
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  /** 元素或画布尺寸变化后需要重新确认快照尺寸。 */
  sizeDirty: boolean

  /** 最近一次传给 `updateElementGeometry()` 的位置；`placed` 为 false 表示还没有设置过。 */
  placed: boolean
  placedLeft: number
  placedTop: number
  placedWidth: number
  placedHeight: number

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
  /** 按压弹簧。 */
  readonly press: SpringState
  /** 材质化弹簧，见 `VolumeSurface.materialize`。 */
  readonly materialize: SpringState
  /** 上一帧元素是否显示（`checkVisibility()`）。由隐藏变为显示时重新材质化。 */
  shown: boolean
  /** 是否曾经显示过。由隐藏变回显示时据此直接在新位置出现，新登记的玻璃不受影响（可能正从同名玻璃流出来）。 */
  everShown: boolean
  /** 元素已经隐藏，玻璃按上一帧的位置与内容退去，材质化回到 0 后不再绘制。 */
  hiding: boolean
  /** 元素已经离开文档，玻璃保留纹理退去，结束后释放。 */
  fading: boolean
  /**
   * 内容显现的进度，0–1，只增不减。出现、同名玻璃交接与展开时从 0 开始，按时间走到 1：
   * 内容的模糊与放大只收敛一次，不跟随玻璃的回弹与晃动。
   */
  reveal: number
  /** 展开期间内容的可见范围（视口坐标：左、上、右、下），只扩大不缩小。 */
  readonly revealClip: number[]
  /** 本次显现是否是展开：此时内容按 `revealClip` 显露。 */
  revealGrowing: boolean
  /** 显现的来源在视口中的位置：展开时内容从这里放大后收拢。 */
  revealX: number
  revealY: number

  /** 元素在视口中的矩形，每帧更新。 */
  readonly rect: Rect
  /** 元素相对定位基准的布局矩形，不受滚动影响。 */
  readonly layout: Rect
  /** 布局坐标的原点在视口中的位置：定位基准的左上角减去它的滚动量。 */
  originX: number
  originY: number
  /** 本帧参与绘制的体积，`hasVolume` 为 false 时不可见。 */
  readonly volume: VolumeSurface
  hasVolume: boolean
  /**
   * 液体流动的拖尾：本体后面一团与本体融合的较小体积，`hasTail` 为 false 时不绘制。
   * 编号取负数，不会与任何玻璃的编号或外层编号相同。
   */
  readonly tail: VolumeSurface
  hasTail: boolean
}

/**
 * 一块具名玻璃移除时，如果页面上还有同名玻璃，它的体积不会立即消失，而是流回那块玻璃并被吸收。
 * 残影只有体积，没有内容；流动结束或目标消失时移除。
 */
export interface GlassGhost {
  /** 迁移的名字，同名玻璃再次出现时从残影当前的位置接手。 */
  readonly name: string
  /** 残影流向的玻璃。 */
  readonly target: GlassSurface
  readonly flow: LiquidFlow
  /** 残影本帧的体积，编号为负数。 */
  readonly volume: VolumeSurface
}

/** 注册时确定的字段。 */
export interface SurfaceInit {
  id: number
  element: HTMLElement
  host: GlassSurface | null
  anchor: HTMLElement | null
  options: GlassOptions
  signature: string
  content: ElementTexture | null
  textureWidth: number
  textureHeight: number
  addedDrawable: boolean
}

/** 创建一块玻璃的状态。每帧使用的对象在这里一次创建。 */
export function createSurface(init: SurfaceInit): GlassSurface {
  return {
    ...init,
    flow: null,
    snapFlow: true,
    handedOver: false,
    partner: null,
    sizeDirty: false,
    placed: false,
    placedLeft: 0,
    placedTop: 0,
    placedWidth: 0,
    placedHeight: 0,
    dirty: true,
    settleFrames: 4,
    paintPending: false,
    contentComplete: false,
    visible: false,
    fullyVisible: false,
    resizeObserver: null,
    retryTimer: null,
    onScroll: () => {},
    onTransitionEnd: () => {},
    press: { value: 0, velocity: 0 },
    materialize: {
      value: init.options.materialize ? 0 : 1,
      velocity: 0,
    },
    shown: false,
    everShown: false,
    hiding: false,
    fading: false,
    reveal: 1,
    revealClip: [0, 0, 0, 0],
    revealGrowing: false,
    revealX: 0,
    revealY: 0,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    layout: { left: 0, top: 0, width: 0, height: 0 },
    originX: 0,
    originY: 0,
    volume: {
      id: init.id,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      layer: init.options.layer,
      options: init.options,
      fusion: init.options.fusion,
      clip: [0, 0, 0, 0],
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      materialize: 1,
      host: init.host?.id ?? null,
    },
    hasVolume: false,
    tail: {
      id: -init.id - 1,
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      layer: init.options.layer,
      options: init.options,
      fusion: 0,
      clip: [0, 0, 0, 0],
      opacity: 1,
      brightness: 1,
      paintOrder: 0,
      press: 0,
      materialize: 1,
      host: init.host?.id ?? null,
    },
    hasTail: false,
    padding: 0,
    contentClip: [0, 0, 0, 0],
    contentOpacity: 1,
    contentScale: 1,
    contentBlur: 0,
    contentOriginX: 0,
    contentOriginY: 0,
    occluders: [],
    occluderCount: 0,
    backdropOccluders: [],
    backdropOccluderCount: 0,
  }
}

/** 一个祖先元素在本帧的矩形与透明度，同一帧内被多块玻璃共用。 */
export interface ElementBox {
  /** 读取矩形时的帧编号。 */
  frame: number
  left: number
  top: number
  right: number
  bottom: number
  /** 读取透明度时的帧编号。 */
  opacityFrame: number
  opacity: number
}

/** 第一次遇到某个祖先元素时创建它的记录。 */
export function createElementBox(): ElementBox {
  return {
    frame: -1,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    opacityFrame: -1,
    opacity: 1,
  }
}

/**
 * 不支持 `checkVisibility()` 时判断元素是否显示：可见、不是 `display: none`，且有布局盒。
 * 会分配样式与矩形列表对象，只作为回退。
 */
export function legacyShown(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
}

/** 读取 `rgba()` / `rgb()` 颜色的 alpha。 */
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

const SCRIM_SELECTOR = attr(GLASS_SCRIM_ATTR)

/** 模态层外玻璃的亮度比例。只在模态层打开期间每帧调用。 */
export function modalFactor(modal: HTMLElement): number {
  const scrim = modal.querySelector<HTMLElement>(SCRIM_SELECTOR)
  if (!scrim)
    return 1
  const shellOpacity = Number.parseFloat(getComputedStyle(modal).opacity)
  const opacity = Number.isFinite(shellOpacity)
    ? shellOpacity
    : 1
  return 1 - colorAlpha(getComputedStyle(scrim).backgroundColor) * opacity
}
