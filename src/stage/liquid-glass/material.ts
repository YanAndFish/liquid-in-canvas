import type { Texture } from 'three/webgpu'
import type { GlassOptions } from './options'
import {
  asin,
  clamp,
  dot,
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
  tan,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, MeshBasicNodeMaterial, Vector2, Vector4 } from 'three/webgpu'

export interface GlassMaterialHandle {
  material: MeshBasicNodeMaterial
  setPanel: (size: Vector2, paddedSize: Vector2, viewport: Vector2) => void
  setOptions: (options: GlassOptions) => void
  setBackdrop: (texture: Texture) => void
  setContent: (texture: Texture) => void
  setOpacity: (opacity: number) => void
  dispose: () => void
}

const lightDirection = vec2(-0.55, -0.84)
const shineColor = vec3(1, 0.98, 0.94)
// The published TSL types require a JoinNode for two runtime nodes, which these two arguments are.
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

export function createGlassMaterial(
  backdrop: Texture,
  content: Texture,
  softBlur: Texture,
  heavyBlur: Texture,
): GlassMaterialHandle {
  const backdropNode = texture(backdrop)
  const contentNode = texture(content)
  const softNode = texture(softBlur)
  const heavyNode = texture(heavyBlur)

  const uniforms = {
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
    const half = uniforms.panelSize.mul(0.5)
    const limit = min(half.x, half.y)
    const radius = min(uniforms.radius, limit)
    const local = vec2(
      uv().x.sub(0.5).mul(uniforms.paddedSize.x),
      float(0.5).sub(uv().y).mul(uniforms.paddedSize.y),
    )

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

    const distance = sdf(local)
    const inside = float(1).sub(smoothstep(-1, 1, distance))
    const insideDepth = distance.negate()
    const thickness = max(uniforms.refraction.mul(1.4), 1)
    const depth = clamp(insideDepth.div(thickness), 0, 1)

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
    const thetaT = asin(clamp(sin(thetaI).div(1.42), 0, 1))
    const edgeFactor = tan(thetaT.sub(thetaI)).negate()
    const offset = normal
      .mul(edgeFactor)
      .mul(uniforms.refraction)
      .div(uniforms.viewport)
      .negate()

    const dispersed = uniforms.dispersion.mul(0.4)
    const sharp = vec3(
      backdropNode.sample(screenUV.add(offset.mul(float(1).add(dispersed)))).r,
      backdropNode.sample(screenUV.add(offset)).g,
      backdropNode.sample(screenUV.add(offset.mul(float(1).sub(dispersed)))).b,
    )

    const center = screenUV.add(offset)
    const soft = softNode.sample(center).rgb
    const heavy = heavyNode.sample(center).rgb
    const blurMix = clamp(uniforms.blur.div(50), 0, 1)
    const blurred = mix(soft, heavy, blurMix)
    const frost = clamp(uniforms.blur.div(12), 0, 1)
    const frostDepth = smoothstep(0.3, 0.95, depth)
    const frosted = mix(sharp, blurred, frostDepth.mul(frost))

    const tinted = mix(frosted, uniforms.tint, uniforms.tintAlpha)
    const line = float(1).sub(clamp(distance.abs().div(2.2), 0, 1))
    const directional = clamp(dot(normal, lightDirection), 0, 1)
    const rim = pow(line, 2)
      .mul(uniforms.specular)
      .mul(float(0.5).add(directional.mul(0.9)))
    const glare = pow(directional, 4)
      .mul(line)
      .mul(uniforms.specular)
      .mul(0.8)
    const fresnel = pow(float(1).sub(depth), 3).mul(0.14)
    const innerShade = smoothstep(-4, 0, distance).mul(0.08)
    const glass = tinted.mul(float(1).sub(innerShade))
      .add(vec3(1).mul(rim))
      .add(shineColor.mul(glare))
      .add(vec3(0.94, 0.97, 1).mul(fresnel))

    const contentUV = local.add(half).div(uniforms.panelSize)
    const contentPixel = contentNode.sample(contentUV)
    const finalColor = mix(glass, contentPixel.rgb, contentPixel.a)

    const shadowT = clamp(distance.div(max(uniforms.shadowSize, 1)), 0, 1)
    const shadowAlpha = uniforms.shadow
      .mul(pow(float(1).sub(shadowT), 2.2))
      .mul(float(1).sub(inside))

    return mix(vec4(0, 0, 0, shadowAlpha), vec4(finalColor, 1), inside)
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
    setOpacity(opacity) {
      material.opacity = opacity
    },
    dispose() {
      material.dispose()
    },
  }

  return handle
}
