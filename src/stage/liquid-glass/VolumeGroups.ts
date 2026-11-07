import type { Node, Scene, Texture } from 'three/webgpu'
import type { VolumeSurface } from './fusion'
import { clamp, dot, exp, float, Fn, If, max, mix, pow, reflect, screenUV, smoothstep, texture, uniform, vec2, vec3, vec4 } from 'three/tsl'
import { Color, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector2, Vector4 } from 'three/webgpu'
import { glassRenderOrder, groupGlassSurfaces } from './fusion'
import { BLUR_SIGMAS } from './gaussian'
import { createVolumeFunctions } from './volume-shader'

/** 一组相连玻璃的绘制资源，成员数量固定，位置逐帧更新。 */
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
  private readonly groups = new Map<string, VolumeGroup>()

  constructor(scene: Scene, blurredTextures: Texture[]) {
    this.scene = scene
    this.blurredTextures = blurredTextures
  }

  /** 更新邻近关系；离屏组合暂存，超出缓存数量时释放。 */
  sync(surfaces: VolumeSurface[], viewport: Vector2, backdrop: Texture): void {
    const used = new Set<string>()
    for (const members of groupGlassSurfaces(surfaces)) {
      const key = members.map(member => member.id).join(':')
      used.add(key)
      let group = this.groups.get(key)
      if (!group) {
        group = this.createGroup(members, backdrop)
        this.groups.set(key, group)
        this.scene.add(group.mesh)
      }
      group.mesh.visible = true
      group.update(members, viewport, backdrop)
      // 把使用中的组移到末尾，缓存最近的组合以减少滚动时重新编译。
      this.groups.delete(key)
      this.groups.set(key, group)
    }
    for (const [key, group] of this.groups) {
      if (used.has(key))
        continue
      group.mesh.visible = false
      if (this.groups.size > 24) {
        this.scene.remove(group.mesh)
        group.dispose()
        this.groups.delete(key)
      }
    }
  }

  /** 释放所有三维玻璃资源。 */
  dispose(): void {
    for (const group of this.groups.values()) {
      this.scene.remove(group.mesh)
      group.dispose()
    }
    this.groups.clear()
    this.geometry.dispose()
  }

  /** 创建共用距离场、法线与 RGB 光路的材质。 */
  private createGroup(members: VolumeSurface[], backdrop: Texture): VolumeGroup {
    const source = texture(backdrop)
    const blurs = this.blurredTextures.map(value => texture(value))
    const viewport = uniform(new Vector2(1, 1))
    const ceiling = uniform(200)
    const shadow = uniform(new Vector2(0.2, 28))
    const fields = members.map(() => ({
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
    const functions = createVolumeFunctions(members.length)
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
        result.assign(vec4(reflected.add(vec3(highlight)), colored.a.mul(coverage)))
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
        current.forEach((member, i) => {
          const field = fields[i]!
          const options = member.options
          const halfDepth = Math.max(2, Math.min(options.refraction, member.width * 0.3, member.height * 0.3))
          field.box.value.set(member.left + member.width / 2, member.top + member.height / 2, member.width / 2 * (1 + member.press * 0.018), member.height / 2 * (1 - member.press * 0.025))
          field.radius.value.set(...options.radius)
          field.depth.value.set(halfDepth, options.elevation, options.fusion, 0)
          field.clip.value.set(...member.clip)
          field.appearance.value.set(options.blur * options.blur, options.dispersion, options.tintAlpha, options.specular)
          field.tint.value.set(options.tint)
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
        mesh.renderOrder = glassRenderOrder(current[0]!.options.layer) + Math.max(...current.map(member => member.paintOrder)) * 0.5
      },
      dispose() { material.dispose() },
    }
  }
}
