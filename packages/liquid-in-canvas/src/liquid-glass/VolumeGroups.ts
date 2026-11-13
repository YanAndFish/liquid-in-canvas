import type { Node, Texture, WebGPURenderer } from 'three/webgpu'
import type { CoverRect } from './cover'
import type { VolumeSurface } from './fusion'
import { clamp, dot, exp, float, Fn, If, max, min, mix, pow, reflect, screenUV, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { Color, CustomBlending, HalfFloatType, Mesh, MeshBasicNodeMaterial, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, PlaneGeometry, RenderTarget, Scene, SRGBColorSpace, Vector2, Vector4 } from 'three/webgpu'
import { glassVolumeRenderOrder } from '../render-order'
import { disjointCover } from './cover'
import { groupGlassSurfaces, pressedBox } from './fusion'
import { BLUR_SIGMAS } from './gaussian'
import { createVolumeFunctions } from './volume-shader'

/** 一组相连玻璃的绘制资源。着色器只取决于成员数量，成员与位置逐帧写入。 */
interface VolumeGroup {
  /** 用于呈现体积的包围矩形。 */
  mesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  /** 包围矩形在视口中的范围，单位为 CSS 像素。 */
  bounds: CoverRect
  /** 更新所有成员和页面快照。 */
  update: (members: VolumeSurface[], viewport: Vector2, backdrop: Texture) => void
  /** 释放材质，几何体由管理器共用。 */
  dispose: () => void
}

/** 体积着色的分辨率设置。 */
export interface VolumeShading {
  /** 着色分辨率相对画布的比例，1 表示直接画进画布。 */
  scale: number
  /** 画布的像素尺寸。 */
  pixelWidth: number
  pixelHeight: number
  /** 视口的 CSS 尺寸。 */
  cssWidth: number
  cssHeight: number
  /** 主场景中插在玻璃之间的其他内容的绘制顺序，低分辨率合成在这里分段。 */
  split: number
}

/** 降低着色分辨率时，一段连续层级的体积组共用的离屏目标，以及把它放大回画布的若干矩形。 */
interface VolumeBand {
  scene: Scene
  target: RenderTarget
  material: MeshBasicNodeMaterial
  /** 互不重叠的合成矩形，只增不减，多余的隐藏。 */
  tiles: Mesh[]
}

const FULL_SHADING: VolumeShading = {
  scale: 1,
  pixelWidth: 1,
  pixelHeight: 1,
  cssWidth: 1,
  cssHeight: 1,
  split: Infinity,
}

/** 按玻璃层级合并邻近实体，并在每组中追踪三维折射光路。 */
export class VolumeGroups {
  private readonly scene: Scene
  private readonly blurredTextures: Texture[]
  private readonly renderer: WebGPURenderer | null
  private readonly geometry = new PlaneGeometry(1, 1)
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  /** 按成员数量分池。同一帧内相同数量的组依次取用，滚动时成员变化不会重建着色器。 */
  private readonly pools = new Map<number, VolumeGroup[]>()
  /** `split` 之下与之上的两段，首次降低分辨率时创建。 */
  private readonly bands: (VolumeBand | null)[] = [null, null]

  /** 不传 `renderer` 时体积组总是直接画进主场景。 */
  constructor(scene: Scene, blurredTextures: Texture[], renderer: WebGPURenderer | null = null) {
    this.scene = scene
    this.blurredTextures = blurredTextures
    this.renderer = renderer
  }

  /**
   * 更新邻近关系并分配绘制资源。
   *
   * 实例只增不减，数量不超过同时可见的玻璃数。按成员编号缓存会在滚动中不断遇到新组合，
   * 每次都要重新构建着色器节点，造成数十毫秒的单帧卡顿。
   */
  sync(surfaces: VolumeSurface[], viewport: Vector2, backdrop: Texture, shading: VolumeShading = FULL_SHADING): void {
    const taken = new Map<number, number>()
    const visible: VolumeGroup[] = []
    for (const members of groupGlassSurfaces(surfaces)) {
      const size = members.length
      const index = taken.get(size) ?? 0
      taken.set(size, index + 1)
      let pool = this.pools.get(size)
      if (!pool) {
        pool = []
        this.pools.set(size, pool)
      }
      let group = pool[index]
      if (!group) {
        group = this.createGroup(size, backdrop)
        pool.push(group)
        this.scene.add(group.mesh)
      }
      group.mesh.visible = true
      group.update(members, viewport, backdrop)
      visible.push(group)
    }
    for (const [size, pool] of this.pools) {
      for (const group of pool.slice(taken.get(size) ?? 0))
        group.mesh.visible = false
    }
    this.compose(visible, shading)
  }

  /** 释放所有三维玻璃资源。 */
  dispose(): void {
    for (const pool of this.pools.values()) {
      for (const group of pool) {
        group.mesh.removeFromParent()
        group.dispose()
      }
    }
    this.pools.clear()
    for (const band of this.bands) {
      if (!band)
        continue
      for (const tile of band.tiles)
        this.scene.remove(tile)
      band.material.dispose()
      band.target.dispose()
    }
    this.bands.fill(null)
    this.geometry.dispose()
  }

  /**
   * 决定体积组画到哪里。
   *
   * 比例为 1 时直接画进主场景。低于 1 时改画进低分辨率的离屏目标，再放大合成：
   * 玻璃后的背景本来就经过折射与模糊，降低分辨率主要让轮廓和高光略微变软，
   * 而页面文字和玻璃上的内容仍按画布分辨率绘制。
   *
   * 合成只覆盖体积组的包围矩形。离屏目标里各组已经相互混合，重叠的包围矩形要先换成
   * 互不重叠的矩形，否则重叠处的阴影会叠加两遍。
   *
   * 合成后一段内的所有体积先于这一段的内容绘制。被上层玻璃盖住的内容已由遮挡蒙版裁掉，
   * 差别只在于上层玻璃的阴影不再压暗下层玻璃上的文字。
   */
  private compose(visible: readonly VolumeGroup[], shading: VolumeShading): void {
    const renderer = this.renderer
    const reduced = renderer !== null && shading.scale < 1
    const orders = [Infinity, Infinity]
    const bounds: CoverRect[][] = [[], []]
    for (const group of visible) {
      const index = group.mesh.renderOrder >= shading.split
        ? 1
        : 0
      const parent = reduced
        ? this.band(index).scene
        : this.scene
      if (group.mesh.parent !== parent)
        parent.add(group.mesh)
      orders[index] = Math.min(orders[index]!, group.mesh.renderOrder)
      bounds[index]!.push(group.bounds)
    }
    this.bands.forEach((band, index) => {
      if (!band)
        return
      const cover = reduced
        ? disjointCover(bounds[index]!)
        : []
      while (band.tiles.length < cover.length) {
        const tile = new Mesh(this.geometry, band.material)
        tile.frustumCulled = false
        this.scene.add(tile)
        band.tiles.push(tile)
      }
      band.tiles.forEach((tile, i) => {
        const rect = cover[i]
        tile.visible = rect !== undefined
        if (!rect)
          return
        tile.position.set((rect.left + rect.right) / shading.cssWidth - 1, 1 - (rect.top + rect.bottom) / shading.cssHeight, 0)
        tile.scale.set((rect.right - rect.left) / shading.cssWidth * 2, (rect.bottom - rect.top) / shading.cssHeight * 2, 1)
        tile.renderOrder = orders[index]!
      })
      if (!cover.length || !renderer)
        return
      band.target.setSize(
        Math.max(1, Math.ceil(shading.pixelWidth * shading.scale)),
        Math.max(1, Math.ceil(shading.pixelHeight * shading.scale)),
      )
      const previousTarget = renderer.getRenderTarget()
      const previousAlpha = renderer.getClearAlpha()
      try {
        // 目标清成全透明，体积按普通混合叠加后得到预乘颜色。
        renderer.setClearAlpha(0)
        renderer.setRenderTarget(band.target)
        renderer.render(band.scene, this.camera)
      }
      finally {
        renderer.setClearAlpha(previousAlpha)
        renderer.setRenderTarget(previousTarget)
      }
    })
  }

  private band(index: number): VolumeBand {
    const existing = this.bands[index]
    if (existing)
      return existing
    const target = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType })
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      // 离屏目标里已经是预乘颜色，按预乘方式叠到画布上。
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
    })
    material.colorNode = texture(target.texture).sample(screenUV)
    const band: VolumeBand = {
      scene: new Scene(),
      target,
      material,
      tiles: [],
    }
    this.bands[index] = band
    return band
  }

  /** 创建指定成员数量的距离场、法线与 RGB 光路材质。 */
  private createGroup(size: number, backdrop: Texture): VolumeGroup {
    const source = texture(backdrop)
    const blurs = this.blurredTextures.map(value => texture(value))
    const viewport = uniform(new Vector2(1, 1))
    const ceiling = uniform(200)
    const shadow = uniform(new Vector2(0.2, 28))
    const brightness = uniform(1)
    const reach = uniform(1)
    const fields = Array.from({ length: size }, () => ({
      box: uniform(new Vector4()),
      radius: uniform(new Vector4()),
      depth: uniform(new Vector4()),
      clip: uniform(new Vector4()),
      appearance: uniform(new Vector4()),
      tint: uniform(new Color()),
      opacity: uniform(1),
    }))
    const args: Record<string, Node> = {}
    fields.forEach((field, i) => {
      args[`b${i}`] = field.box
      args[`r${i}`] = field.radius
      args[`d${i}`] = field.depth
      args[`c${i}`] = field.clip
    })
    const functions = createVolumeFunctions(size)
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    /**
     * 按方差选择高斯层。相邻两层之外的权重恒为 0 或 1，因此每次只取样真正参与插值的层。
     * 传入一个坐标时三通道共用一次取样，传入三个坐标时按 RGB 光路分别取样。
     */
    // 这些纹理都没有多级渐远，显式取第 0 级可以在分支内取样而不依赖屏幕空间导数。
    const lod = float(0)
    const sampleBlur = (coords: readonly Node<'vec2'>[], variance: Node<'float'>): Node<'vec3'> => {
      const pick = (level: typeof source): Node<'vec3'> => coords.length === 1
        ? level.sample(coords[0]!).level(lod).rgb
        : vec3(level.sample(coords[0]!).level(lod).r, level.sample(coords[1]!).level(lod).g, level.sample(coords[2]!).level(lod).b)
      const weights = BLUR_SIGMAS.map((sigma, i) => {
        const previous = BLUR_SIGMAS[i - 1] ?? 0
        return clamp(variance.sub(previous * previous).div(sigma * sigma - previous * previous), 0, 1).toVar()
      })
      const sampled = vec3(0).toVar()
      If(weights[0]!.lessThan(1), () => {
        sampled.assign(pick(source))
      })
      weights.forEach((weight, i) => {
        const next = weights[i + 1]
        const needed = next
          ? weight.greaterThan(0).and(next.lessThan(1))
          : weight.greaterThan(0)
        If(needed, () => {
          sampled.assign(mix(sampled, pick(blurs[i]!), weight))
        })
      })
      return sampled
    }
    material.colorNode = Fn(() => {
      const xy = screenUV.mul(viewport).toVar()
      const outline = float(functions.projection({ xy, ...args }) as Node<'float'>).toVar()
      const distance = float(functions.projection({
        xy: xy.sub(vec2(0, 4)),
        ...args,
      }) as Node<'float'>)
      const shadowAlpha = exp(max(distance, 0).div(max(shadow.y, 1)).mul(-4)).mul(shadow.x)
      const result = vec4(0, 0, 0, shadowAlpha).toVar()
      const coverage = float(1).sub(smoothstep(-0.7, 0.3, outline))
      const appearanceArgs: Record<string, Node> = {}
      const colorArgs: Record<string, Node> = {}
      fields.forEach((field, i) => {
        appearanceArgs[`v${i}`] = field.appearance
        // 透明材质的染色值不应把不透明一端的颜色冲淡。
        colorArgs[`v${i}`] = vec4(field.tint.mul(field.appearance.z), field.opacity)
      })
      /** 取融合后的光学参数（模糊方差、色散、染色比例、高光）与染色。 */
      const blendAt = (p: Node<'vec3'>) => {
        const optics = vec4(functions.blend({
          p,
          ...args,
          ...appearanceArgs,
        }) as Node<'vec4'>).toVar()
        const colored = vec4(functions.blend({
          p,
          ...args,
          ...colorArgs,
        }) as Node<'vec4'>).toVar()
        const color = colored.rgb.div(max(optics.z, 0.0001)).toVar()
        return { optics, colored, color }
      }
      // 任意高度的距离都不小于最宽截面处的投影距离，投影在轮廓之外的像素不可能与实体相交，只需绘制阴影。
      If(outline.lessThan(0.02), () => {
        const top = float(functions.slab({ xy, reach, ...args }) as Node<'float'>).toVar()
        If(top.greaterThanEqual(0), () => {
          // 平顶区域：光线垂直穿过等厚平板，不发生偏折，也没有轮廓高光。
          const { optics, colored, color } = blendAt(vec3(xy, top))
          const here = clamp(screenUV, 0.001, 0.999)
          const transmitted = sampleBlur([here], optics.x)
          const environment = sampleBlur([here], optics.x.add(64))
          const reflected = mix(mix(transmitted, color, optics.z), environment, clamp(optics.w.mul(0.034), 0, 1))
          result.assign(vec4(reflected, colored.a.mul(coverage)))
        }).Else(() => {
          const entry = vec4(functions.entry({ xy, ceiling, ...args }) as Node<'vec4'>).toVar()
          If(entry.w.greaterThan(0.5), () => {
            const normal = vec3(functions.normal({ p: entry.xyz, ...args }) as Node<'vec3'>).toVar()
            const { optics, colored, color } = blendAt(entry.xyz)
            const spread = optics.y.mul(0.055).toVar()
            const trace = (ior: Node<'float'>) => vec4(functions.exit({
              entry: entry.xyz,
              normal,
              ior,
              ...args,
            }) as Node<'vec4'>)
            const green = trace(float(1.45)).toVar()
            const red = vec4(green).toVar()
            const blue = vec4(green).toVar()
            // 没有色散时三条光路重合，只追踪一次。
            If(spread.greaterThan(0.00001), () => {
              red.assign(trace(float(1.45).sub(spread)))
              blue.assign(trace(float(1.45).add(spread)))
            })
            const redUV = clamp(red.xy.div(viewport), 0.001, 0.999)
            const greenUV = clamp(green.xy.div(viewport), 0.001, 0.999)
            const blueUV = clamp(blue.xy.div(viewport), 0.001, 0.999)
            const transmitted = sampleBlur([redUV, greenUV, blueUV], optics.x)
            // 反射方向由三维法线决定；有限距离的页面环境近似用柔化采样表示表面粗糙度。
            const reflection = reflect(vec3(0, 0, -1), normal)
            const environmentUV = clamp(screenUV.add(reflection.xy.mul(48).div(viewport)), 0.001, 0.999)
            const environment = sampleBlur([environmentUV], optics.x.add(64))
            const fresnel = float(0.034).add(pow(float(1).sub(clamp(normal.z, 0, 1)), 5).mul(0.966))
            const tinted = mix(transmitted, color, optics.z)
            const valid = vec3(red.w, green.w, blue.w).toVar()
            const refracted = vec3(tinted).toVar()
            // 求交次数耗尽或光线朝向屏幕外时，使用本地柔化背景，避免连接处出现远处亮色碎边。
            If(min(valid.x, min(valid.y, valid.z)).lessThan(1), () => {
              const localEnvironment = sampleBlur([screenUV], optics.x)
              refracted.assign(mix(mix(localEnvironment, color, optics.z), tinted, valid))
            })
            const reflected = mix(refracted, environment, clamp(fresnel.mul(optics.w), 0, 1))
            const light = pow(max(dot(normal, vec3(-0.45, -0.6, 0.66).normalize()), 0), 32)
            const edge = pow(float(1).sub(clamp(normal.z, 0, 1)), 3)
            const highlight = light.mul(0.035).mul(edge).add(edge.mul(0.035)).mul(optics.w)
            result.assign(vec4(reflected.add(vec3(highlight.mul(brightness))), colored.a.mul(coverage)))
          })
        })
      })
      let clipCoverage: Node<'float'> = float(0)
      for (const field of fields) {
        const outside = max(max(field.clip.x.sub(xy.x), xy.x.sub(field.clip.z)), max(field.clip.y.sub(xy.y), xy.y.sub(field.clip.w)))
        clipCoverage = max(clipCoverage, float(1).sub(smoothstep(-0.5, 0.5, outside)))
      }
      return vec4(result.rgb, result.a.mul(clipCoverage))
    })()
    const mesh = new Mesh(this.geometry, material)
    mesh.frustumCulled = false
    const bounds: CoverRect = { left: 0, top: 0, right: 0, bottom: 0 }
    return {
      mesh,
      bounds,
      update(current, size, background) {
        viewport.value.copy(size)
        source.value = background
        let left = Infinity
        let top = Infinity
        let right = -Infinity
        let bottom = -Infinity
        let highest = 0
        let shadowAlpha = 0
        let shadowSize = 0
        let fusion = 0
        // 背景已经含有遮罩。仅压暗新增的染色与高光，玻璃覆盖率保持不变。
        brightness.value = new Color().setRGB(current[0]!.brightness, current[0]!.brightness, current[0]!.brightness, SRGBColorSpace).r
        current.forEach((member, i) => {
          const field = fields[i]!
          const options = member.options
          const halfDepth = Math.max(2, Math.min(options.refraction, member.width * 0.3, member.height * 0.3))
          field.box.value.set(...pressedBox(member))
          field.radius.value.set(...options.radius)
          field.depth.value.set(halfDepth, options.elevation, options.fusion, 0)
          field.clip.value.set(...member.clip)
          field.appearance.value.set(options.blur * options.blur, options.dispersion, options.tintAlpha, options.specular)
          field.tint.value.set(options.tint).multiplyScalar(brightness.value)
          field.opacity.value = member.opacity
          shadowAlpha = Math.max(shadowAlpha, options.shadow * member.opacity)
          shadowSize = Math.max(shadowSize, options.shadowSize)
          fusion = Math.max(fusion, options.fusion)
          const padding = Math.max(options.fusion, options.shadowSize) + 3
          left = Math.min(left, member.left - padding)
          top = Math.min(top, member.top - padding)
          right = Math.max(right, member.left + member.width + padding)
          bottom = Math.max(bottom, member.top + member.height + padding)
          highest = Math.max(highest, options.elevation + halfDepth * 2 + options.fusion)
        })
        ceiling.value = highest + 4
        // 每一步平滑合并最多让距离减小半径的四分之一，按成员数量留出余量。
        reach.value = fusion * 2 * (1 + current.length / 4) + 1
        shadow.value.set(shadowAlpha, shadowSize)
        left = Math.max(0, left)
        top = Math.max(0, top)
        right = Math.min(size.x, right)
        bottom = Math.min(size.y, bottom)
        Object.assign(bounds, { left, top, right, bottom })
        mesh.position.set((left + right) / size.x - 1, 1 - (top + bottom) / size.y, 0)
        mesh.scale.set((right - left) / size.x * 2, (bottom - top) / size.y * 2, 1)
        mesh.renderOrder = glassVolumeRenderOrder(current[0]!.options.layer, Math.max(...current.map(member => member.paintOrder)))
      },
      dispose() { material.dispose() },
    }
  }
}
