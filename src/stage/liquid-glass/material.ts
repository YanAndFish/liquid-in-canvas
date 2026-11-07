import type { Node, Texture } from 'three/webgpu'
import type { GlassOptions } from './options'
import {
  asin,
  clamp,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  min,
  mix,
  pow,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  tan,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, MeshBasicNodeMaterial, Vector2, Vector4 } from 'three/webgpu'
import { BLUR_SIGMAS } from './gaussian'

/** 管理一块玻璃的材质参数及内容纹理。 */
export interface GlassMaterialHandle {
  /** 用于 WebGPU 绘制的节点材质。 */
  material: MeshBasicNodeMaterial
  /** 设置面板、阴影范围和视口的 CSS 尺寸。 */
  setPanel: (size: Vector2, paddedSize: Vector2, viewport: Vector2) => void
  /** 更新折射、模糊与染色参数。 */
  setOptions: (options: GlassOptions) => void
  /** 更新玻璃背后的页面快照。 */
  setBackdrop: (texture: Texture) => void
  /** 更新文字与控件的透明快照。 */
  setContent: (texture: Texture) => void
  /** 设置指针位置、悬停强度与按压强度。 */
  setInteraction: (x: number, y: number, hover: number, press: number) => void
  /** 设置可绘制范围，单位为 CSS 像素。 */
  setClip: (left: number, top: number, right: number, bottom: number) => void
  /** 设置整个面板的透明度。 */
  setOpacity: (opacity: number) => void
  /** 释放材质资源。 */
  dispose: () => void
}

const shineColor = vec3(1, 0.98, 0.94)
// TSL 的 vec2 类型重载要求 JoinNode，这两个运行时参数均由节点组成。
type Vec2Node = ReturnType<typeof vec2>
const joinVec2 = vec2 as unknown as (x: unknown, y: unknown) => Vec2Node
function addVec2(point: Vec2Node, offset: Vec2Node): Vec2Node {
  return (point.add as unknown as (value: Vec2Node) => Vec2Node)(offset)
}
function scaleVec2(value: Vec2Node, scale: number): Vec2Node {
  return value.mul(scale) as unknown as Vec2Node
}
function subVec2(point: Vec2Node, offset: Vec2Node): Vec2Node {
  return addVec2(point, scaleVec2(offset, -1))
}

/** 合成背景透镜、环境光、接触反馈与清晰的 HTML 内容。 */
export function createGlassMaterial(
  backdrop: Texture,
  content: Texture,
  blurredTextures: Texture[],
): GlassMaterialHandle {
  const backdropNode = texture(backdrop)
  const contentNode = texture(content)
  const blurNodes = blurredTextures.map(value => texture(value))
  const environmentNode = blurNodes[2]!

  const uniforms = {
    pointer: uniform(new Vector2(0, 0)),
    hover: uniform(0),
    press: uniform(0),
    regular: uniform(1),
    clip: uniform(new Vector4(0, 0, 100000, 100000)),
    panelSize: uniform(new Vector2(1, 1)),
    paddedSize: uniform(new Vector2(1, 1)),
    viewport: uniform(new Vector2(1, 1)),
    radius: uniform(new Vector4(28, 28, 28, 28)),
    blur: uniform(18),
    refraction: uniform(22),
    dispersion: uniform(0.25),
    tint: uniform(new Color('#ffffff')),
    tintAlpha: uniform(0.04),
    specular: uniform(0.7),
    shadow: uniform(0.32),
    shadowSize: uniform(32),
  }

  const colorNode = Fn(() => {
    // 按压使轮廓轻微横向伸展；内容和材质共用同一坐标变换。
    const deformation = vec2(float(1).add(uniforms.press.mul(0.018)), float(1).sub(uniforms.press.mul(0.025)))
    const half = uniforms.panelSize.mul(0.5)
    const limit = min(half.x, half.y)
    const radius = min(uniforms.radius, limit)
    const local = vec2(
      uv().x.sub(0.5).mul(uniforms.paddedSize.x),
      float(0.5).sub(uv().y).mul(uniforms.paddedSize.y),
    ).div(deformation)

    const cornerRadius = (point: typeof local) => select(
      point.x.lessThan(0),
      select(point.y.lessThan(0), radius.x, radius.w),
      select(point.y.lessThan(0), radius.y, radius.z),
    )

    const sdf = (point: Vec2Node) => {
      const corner = cornerRadius(point)
      const q = point.abs().sub(half).add(corner)
      return length(max(q, vec2(0))).add(min(max(q.x, q.y), float(0))).sub(corner)
    }

    const distance = sdf(local as Vec2Node)
    const inside = float(1).sub(smoothstep(-1, 1, distance))
    const insideDepth = distance.negate()
    // 折射带随控件尺寸变化，避免小胶囊整个表面都被挤成透镜。
    const thickness = max(min(uniforms.refraction.mul(0.65), limit.mul(0.75)), 1)

    const epsilon = float(0.75)
    const zero = float(0)
    const horizontal = joinVec2(epsilon, zero)
    const vertical = joinVec2(zero, epsilon)
    const gradient = joinVec2(
      sdf(addVec2(local as Vec2Node, horizontal)).sub(sdf(subVec2(local as Vec2Node, horizontal))),
      sdf(addVec2(local as Vec2Node, vertical)).sub(sdf(subVec2(local as Vec2Node, vertical))),
    )
    const gradientLength = length(gradient)
    const normal = select(
      gradientLength.greaterThan(0.0001),
      gradient.div(max(gradientLength, 0.0001)),
      vec2(0),
    ) as unknown as Vec2Node

    const ratio = clamp(float(1).sub(insideDepth.div(thickness)), 0, 1)
    const thetaI = asin(clamp(pow(ratio, 2), 0, 1))
    const refractedOffset = (index: Node<'float'>) => {
      const thetaT = asin(clamp(sin(thetaI).div(index), 0, 1))
      return normal.mul(tan(thetaT.sub(thetaI))).mul(uniforms.refraction).div(uniforms.viewport)
    }
    // 不同波长使用各自的折射率。模糊作用于全部通道，包括轮廓处的透射。
    const indexSpread = uniforms.dispersion.mul(0.055)
    const redUV = screenUV.add(refractedOffset(float(1.42).sub(indexSpread)))
    const greenUV = screenUV.add(refractedOffset(float(1.42)))
    const blueUV = screenUV.add(refractedOffset(float(1.42).add(indexSpread)))
    let transmitted: Node<'vec3'> = vec3(
      backdropNode.sample(redUV).r,
      backdropNode.sample(greenUV).g,
      backdropNode.sample(blueUV).b,
    )
    let previousSigma = 0
    // 在相邻卷积层间按方差插值；超过第一层后不混入清晰背景。
    for (let index = 0; index < BLUR_SIGMAS.length; index++) {
      const sigma = BLUR_SIGMAS[index]!
      const node = blurNodes[index]!
      const level = vec3(node.sample(redUV).r, node.sample(greenUV).g, node.sample(blueUV).b)
      const weight = clamp(
        uniforms.blur.mul(uniforms.blur).sub(previousSigma * previousSigma)
          .div(sigma * sigma - previousSigma * previousSigma),
        0,
        1,
      )
      transmitted = mix(transmitted, level, weight)
      previousSigma = sigma
    }
    const environmentUV = screenUV.add(normal.mul(thickness.add(8)).div(uniforms.viewport))
    const environment = environmentNode.sample(environmentUV).rgb

    // Regular 压缩背景明暗反差；Clear 保留媒体色彩，由界面的局部暗色衬底承托白字。
    const luminance = dot(environmentNode.sample(screenUV).rgb, vec3(0.2126, 0.7152, 0.0722))
    const adaptiveTint = uniforms.tintAlpha.add(uniforms.regular.mul(luminance).mul(0.12))
    const tinted = mix(transmitted, uniforms.tint, clamp(adaptiveTint, 0, 0.85))
    const lightDirection = uniforms.pointer.mul(0.22).add(vec2(-0.55, -0.84)).normalize()
    const directional = dot(normal, lightDirection)
    const primary = pow(max(directional, 0), 5)
    const opposite = pow(max(directional.negate(), 0), 7).mul(0.55)
    // 掠射角提高环境反射占比，轮廓高光只勾勒受光部分。
    const cosTheta = sqrt(max(float(1).sub(pow(ratio, 4)), 0))
    const fresnel = float(0.03).add(pow(float(1).sub(cosTheta), 5).mul(0.97))
    const reflection = fresnel.mul(0.48).mul(uniforms.specular)
    const reflected = mix(tinted, environment.mul(0.9).add(shineColor.mul(0.1)), reflection)
    const rim = exp(insideDepth.abs().mul(-1.5))
    const shoulder = exp(max(insideDepth, 0).mul(-0.32))
    const highlight = rim.mul(primary.add(opposite).mul(0.65).add(0.025))
    const sheen = shoulder.mul(primary.add(opposite)).mul(0.065)
    const contact = exp(length(local.div(half).sub(uniforms.pointer)).mul(-2.5))
      .mul(uniforms.press.mul(0.14).add(uniforms.hover.mul(0.018)))
    const glass = reflected
      .mul(float(1).sub(shoulder.mul(0.04)))
      .add(shineColor.mul(highlight.add(sheen)).mul(uniforms.specular))
      .add(vec3(contact))

    const contentUV = local.add(half).div(uniforms.panelSize)
    const contentPixel = contentNode.sample(contentUV)
    const finalColor = mix(glass, contentPixel.rgb, contentPixel.a)

    // 阴影略向下偏移，边界附近留出透光空间。
    const shadowDistance = max(sdf(local.sub(vec2(0, 5)) as Vec2Node), 0)
    const shadowAlpha = uniforms.shadow
      .mul(exp(shadowDistance.div(max(uniforms.shadowSize, 1)).mul(-4)))
      .mul(float(1).sub(inside))
    const pixel = screenUV.mul(uniforms.viewport)
    const clip = smoothstep(uniforms.clip.x, uniforms.clip.x.add(0.5), pixel.x)
      .mul(float(1).sub(smoothstep(uniforms.clip.z.sub(0.5), uniforms.clip.z, pixel.x)))
      .mul(smoothstep(uniforms.clip.y, uniforms.clip.y.add(0.5), pixel.y))
      .mul(float(1).sub(smoothstep(uniforms.clip.w.sub(0.5), uniforms.clip.w, pixel.y)))
    const result = mix(vec4(0, 0, 0, shadowAlpha), vec4(finalColor, 1), inside)
    return vec4(result.rgb, result.a.mul(clip))
  })()

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  material.colorNode = colorNode

  const handle: GlassMaterialHandle = {
    material,
    setPanel(size, paddedSize, viewport) {
      uniforms.panelSize.value.copy(size)
      uniforms.paddedSize.value.copy(paddedSize)
      uniforms.viewport.value.copy(viewport)
    },
    setOptions(options) {
      uniforms.regular.value = options.variant === 'regular'
        ? 1
        : 0
      uniforms.radius.value.set(...options.radius)
      uniforms.blur.value = options.blur
      uniforms.refraction.value = options.refraction
      uniforms.dispersion.value = options.dispersion
      uniforms.tint.value.set(options.tint)
      uniforms.tintAlpha.value = options.tintAlpha
      uniforms.specular.value = options.specular
      uniforms.shadow.value = options.shadow
      uniforms.shadowSize.value = options.shadowSize
    },
    setBackdrop(texture) {
      backdropNode.value = texture
    },
    setContent(texture) {
      contentNode.value = texture
    },
    setInteraction(x, y, hover, press) {
      uniforms.pointer.value.set(x, y)
      uniforms.hover.value = hover
      uniforms.press.value = press
    },
    setClip(left, top, right, bottom) {
      uniforms.clip.value.set(left, top, right, bottom)
    },
    setOpacity(opacity) {
      material.opacity = opacity
    },
    dispose() {
      material.dispose()
    },
  }

  return handle
}
