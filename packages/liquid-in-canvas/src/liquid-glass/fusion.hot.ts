import type { GlassOptions } from './options'
import { createGroup, growUint8 } from './pools'

/**
 * 参与三维融合的一块玻璃，坐标使用视口 CSS 像素。
 *
 * 舞台为每块玻璃保留一个对象，每帧改写字段，不要在一帧之外保留它的值。
 */
export interface VolumeSurface {
  /** 生命周期内稳定的表面编号。 */
  id: number
  /** 左侧位置。 */
  left: number
  /** 顶部位置。 */
  top: number
  /** 未变形宽度。 */
  width: number
  /** 未变形高度。 */
  height: number
  /** 玻璃层级。嵌套玻璃取外层的层级。 */
  layer: number
  /** 外观参数。 */
  options: GlassOptions
  /** 融合距离。通常等于 `options.fusion`；液体流动的拖尾按它离本体的距离取较小的值。 */
  fusion: number
  /** 祖先裁剪范围，依次为左、上、右、下。 */
  clip: number[]
  /** 页面切换产生的透明度。 */
  opacity: number
  /** 遮罩下的亮度比例。背景快照已压暗，此值只作用于染色和高光。 */
  brightness: number
  /** 同层内的 HTML 绘制顺序，归一化到 0–1。 */
  paintOrder: number
  /** 按压弹簧的当前强度。 */
  press: number
  /** 嵌套玻璃所在外层玻璃的编号，顶层玻璃为 null。 */
  host: number | null
}

/** 一组相连的玻璃，成员按表面编号排列。对象在 `GlassGroups` 里复用。 */
export interface GlassGroup {
  readonly members: VolumeSurface[]
  count: number
}

/** 可按下标写入数字的目标，例如 `Float32Array` 或普通数组。 */
export interface NumberSink {
  [index: number]: number
}

/** 返回两个矩形间的最短距离；重叠时为零。 */
export function surfaceGap(a: VolumeSurface, b: VolumeSurface): number {
  return Math.hypot(
    Math.max(a.left - b.left - b.width, b.left - a.left - a.width, 0),
    Math.max(a.top - b.top - b.height, b.top - a.top - a.height, 0),
  )
}

/** 两块玻璃能否融合：同层、同一个外层，且距离不超过两者中较小的融合距离。 */
function fusable(a: VolumeSurface, b: VolumeSurface): boolean {
  if (a.layer !== b.layer || a.host !== b.host)
    return false
  const reach = Math.min(a.fusion, b.fusion)
  return reach > 0 && surfaceGap(a, b) <= reach
}

/**
 * 写入按压后的轮廓：中心坐标与半宽高。横向略微拉伸、纵向压缩。
 * 体积距离场和内容遮挡必须使用同一形状。
 */
export function writePressedBox(target: NumberSink, offset: number, surface: VolumeSurface): void {
  target[offset] = surface.left + surface.width / 2
  target[offset + 1] = surface.top + surface.height / 2
  target[offset + 2] = surface.width / 2 * (1 + surface.press * 0.018)
  target[offset + 3] = surface.height / 2 * (1 - surface.press * 0.025)
}

/**
 * 按层级与邻近关系分组，间接相连的表面一起绘制。
 *
 * 顶层玻璃只与顶层玻璃融合；嵌套玻璃只与同一块外层玻璃里的嵌套玻璃融合，
 * 不会和自己的外层合成一个体积。分组对象与成员数组都复用，每帧调用 `build()` 重新填写。
 */
export class GlassGroups {
  readonly groups: GlassGroup[] = []
  count = 0
  private taken = new Uint8Array(32)

  /** 按 `surfaces` 的前 `count` 项分组。组的先后与每组第一个成员在输入中的先后一致。 */
  build(surfaces: readonly VolumeSurface[], count: number): void {
    if (this.taken.length < count)
      this.taken = growUint8(count)
    const taken = this.taken
    taken.fill(0, 0, count)
    this.count = 0
    for (let first = 0; first < count; first++) {
      if (taken[first])
        continue
      taken[first] = 1
      const group = this.groups[this.count] ?? this.grow()
      this.count++
      const members = group.members
      members[0] = surfaces[first]!
      group.count = 1
      // 广度优先：新加入的成员继续寻找邻居，按输入顺序检查候选。
      for (let index = 0; index < group.count; index++) {
        const current = members[index]!
        for (let candidate = first + 1; candidate < count; candidate++) {
          if (taken[candidate] || !fusable(current, surfaces[candidate]!))
            continue
          taken[candidate] = 1
          members[group.count++] = surfaces[candidate]!
        }
      }
      sortById(members, group.count)
    }
  }

  private grow(): GlassGroup {
    const group = createGroup()
    this.groups[this.count] = group
    return group
  }
}

/** 按表面编号排列，插入排序。 */
function sortById(members: VolumeSurface[], count: number): void {
  for (let i = 1; i < count; i++) {
    const item = members[i]!
    let j = i - 1
    while (j >= 0 && members[j]!.id > item.id) {
      members[j + 1] = members[j]!
      j--
    }
    members[j + 1] = item
  }
}
