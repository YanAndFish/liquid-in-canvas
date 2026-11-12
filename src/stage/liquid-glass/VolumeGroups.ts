import type { Node, Scene, Texture } from 'three/webgpu'
import type { VolumeSurface } from './fusion'
import { clamp, dot, exp, float, Fn, If, max, mix, pow, reflect, screenUV, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { Color, Mesh, MeshBasicNodeMaterial, PlaneGeometry, SRGBColorSpace, Vector2, Vector4 } from 'three/webgpu'
import { glassVolumeRenderOrder } from '../render-order'
import { groupGlassSurfaces, pressedBox } from './fusion'
import { BLUR_SIGMAS } from './gaussian'
import { createVolumeFunctions } from './volume-shader'

/** 一组相连玻璃的绘制资源。着色器只取决于成员数量，成员与位置逐帧写入。 */
interface VolumeGroup {
  /** 用于呈现体积的包围矩形。 */
  mesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  /** 更新所有成员和页面快照。 */
  update: (members: VolumeSurface[], viewport: Vector2, backdrop: Texture) => void
  /** 释放材质，几何体由管理器共用。 */
  dispose: () => void
}

/** 按玻璃层级合并邻近实体，并在每组中追踪三维折射光路。 */
export class VolumeGroups {
  private readonly scene: Scene
  private readonly blurredTextures: Texture[]
  private readonly geometry = new PlaneGeometry(1, 1)
  /** 按成员数量分池。同一帧内相同数量的组依次取用，滚动时成员变化不会重建着色器。 */
  private readonly pools = new Map<number, VolumeGroup[]>()

  constructor(scene: Scene, blurredTextures: Texture[]) {
    this.scene = scene
    this.blurredTextures = blurredTextures
  }

  /**
   * 更新邻近关系并分配绘制资源。
   *
   * 实例只增不减，数量不超过同时可见的玻璃数。按成员编号缓存会在滚动中不断遇到新组合，
   * 每次都要重新构建着色器节点，造成数十毫秒的单帧卡顿。
   */
  sync(surfaces: VolumeSurface[], viewport: Vector2, backdrop: Texture): void {
    const taken = new Map<number, number>()
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
    }
    for (const [size, pool] of this.pools) {
      for (const group of pool.slice(taken.get(size) ?? 0))
        group.mesh.visible = false
    }
  }

  /** 释放所有三维玻璃资源。 */
  dispose(): void {
    for (const pool of this.pools.values()) {
      for (const group of pool) {
        this.scene.remove(group.mesh)
        group.dispose()
      }
    }
    this.pools.clear()
    this.geometry.dispose()
  }

  /** 创建指定成员数量的距离场、法线与 RGB 光路材质。 */
  private createGroup(size: number, backdrop: Texture): VolumeGroup {
    const source = texture(backdrop)
    const blurs = this.blurredTextures.map(value => texture(value))
    const viewport = uniform(new Vector2(1, 1))
    const ceiling = uniform(200)
    const shadow = uniform(new Vector2(0.2, 28))
    const brightness = uniform(1)
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
    material.colorNode = Fn(() => {
      const xy = screenUV.mul(viewport).toVar()
      const entry = vec4(functions.entry({ xy, ceiling, ...args }) as Node<'vec4'>).toVar()
      const distance = float(functions.projection({
        xy: xy.sub(vec2(0, 4)),
        ...args,
      }) as Node<'float'>)
      const shadowAlpha = exp(max(distance, 0).div(max(shadow.y, 1)).mul(-4)).mul(shadow.x)
      const result = vec4(0, 0, 0, shadowAlpha).toVar()
      If(entry.w.greaterThan(0.5), () => {
        const normal = vec3(functions.normal({ p: entry.xyz, ...args }) as Node<'vec3'>).toVar()
        const appearanceArgs: Record<string, Node> = {}
        const colorArgs: Record<string, Node> = {}
        fields.forEach((field, i) => {
          appearanceArgs[`v${i}`] = field.appearance
          // 透明材质的染色值不应把不透明一端的颜色冲淡。
          colorArgs[`v${i}`] = vec4(field.tint.mul(field.appearance.z), field.opacity)
        })
        const optics = vec4(functions.blend({
          p: entry.xyz,
          ...args,
          ...appearanceArgs,
        }) as Node<'vec4'>).toVar()
        const colored = vec4(functions.blend({
          p: entry.xyz,
          ...args,
          ...colorArgs,
        }) as Node<'vec4'>).toVar()
        const color = colored.rgb.div(max(optics.z, 0.0001)).toVar()
        const spread = optics.y.mul(0.055)
        const red = vec4(functions.exit({
          entry: entry.xyz,
          normal,
          ior: float(1.45).sub(spread),
          ...args,
        }) as Node<'vec4'>).toVar()
        const green = vec4(functions.exit({
          entry: entry.xyz,
          normal,
          ior: float(1.45),
          ...args,
        }) as Node<'vec4'>).toVar()
        const blue = vec4(functions.exit({
          entry: entry.xyz,
          normal,
          ior: float(1.45).add(spread),
          ...args,
        }) as Node<'vec4'>).toVar()
        const redUV = clamp(red.xy.div(viewport), 0.001, 0.999)
        const greenUV = clamp(green.xy.div(viewport), 0.001, 0.999)
        const blueUV = clamp(blue.xy.div(viewport), 0.001, 0.999)
        /** 按融合后的方差选择高斯层，三条光路使用相同的模糊强度。 */
        const sampleBlur = (red: Node<'vec2'>, green: Node<'vec2'>, blue: Node<'vec2'>, variance: Node<'float'> = optics.x) => {
          let sampled: Node<'vec3'> = vec3(source.sample(red).r, source.sample(green).g, source.sample(blue).b)
          let previous = 0
          for (let i = 0; i < BLUR_SIGMAS.length; i++) {
            const sigma = BLUR_SIGMAS[i]!
            const blurred = blurs[i]!
            const level = vec3(blurred.sample(red).r, blurred.sample(green).g, blurred.sample(blue).b)
            const weight = clamp(variance.sub(previous * previous).div(sigma * sigma - previous * previous), 0, 1)
            sampled = mix(sampled, level, weight)
            previous = sigma
          }
          return sampled
        }
        const transmitted = sampleBlur(redUV, greenUV, blueUV)
        // 反射方向由三维法线决定；有限距离的页面环境近似用柔化采样表示表面粗糙度。
        const reflection = reflect(vec3(0, 0, -1), normal)
        const environmentUV = clamp(screenUV.add(reflection.xy.mul(48).div(viewport)), 0.001, 0.999)
        const reflectionVariance = optics.x.add(64)
        const environment = sampleBlur(environmentUV, environmentUV, environmentUV, reflectionVariance)
        const fresnel = float(0.034).add(pow(float(1).sub(clamp(normal.z, 0, 1)), 5).mul(0.966))
        const tinted = mix(transmitted, color, optics.z)
        const valid = vec3(red.w, green.w, blue.w)
        // 求交次数耗尽或光线朝向屏幕外时，使用本地柔化背景，避免连接处出现远处亮色碎边。
        const localEnvironment = sampleBlur(screenUV, screenUV, screenUV)
        const refracted = mix(mix(localEnvironment, color, optics.z), tinted, valid)
        const reflected = mix(refracted, environment, clamp(fresnel.mul(optics.w), 0, 1))
        const light = pow(max(dot(normal, vec3(-0.45, -0.6, 0.66).normalize()), 0), 32)
        const edge = pow(float(1).sub(clamp(normal.z, 0, 1)), 3)
        const highlight = light.mul(0.035).mul(edge).add(edge.mul(0.035)).mul(optics.w)
        const outline = float(functions.projection({ xy, ...args }) as Node<'float'>)
        const coverage = float(1).sub(smoothstep(-0.7, 0.3, outline))
        result.assign(vec4(reflected.add(vec3(highlight.mul(brightness))), colored.a.mul(coverage)))
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
    return {
      mesh,
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
          const padding = Math.max(options.fusion, options.shadowSize) + 3
          left = Math.min(left, member.left - padding)
          top = Math.min(top, member.top - padding)
          right = Math.max(right, member.left + member.width + padding)
          bottom = Math.max(bottom, member.top + member.height + padding)
          highest = Math.max(highest, options.elevation + halfDepth * 2 + options.fusion)
        })
        ceiling.value = highest + 4
        shadow.value.set(shadowAlpha, shadowSize)
        left = Math.max(0, left)
        top = Math.max(0, top)
        right = Math.min(size.x, right)
        bottom = Math.min(size.y, bottom)
        mesh.position.set((left + right) / size.x - 1, 1 - (top + bottom) / size.y, 0)
        mesh.scale.set((right - left) / size.x * 2, (bottom - top) / size.y * 2, 1)
        mesh.renderOrder = glassVolumeRenderOrder(current[0]!.options.layer, Math.max(...current.map(member => member.paintOrder)))
      },
      dispose() { material.dispose() },
    }
  }
}
