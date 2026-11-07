import type { Texture } from 'three/webgpu'
import type { GlassOptions } from './options'
import {
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
  smoothstep,
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
const joinVec2 = vec2 as unknown as (x: unknown, y: unknown) => ReturnType<typeof vec2>

export function createGlassMaterial(backdrop: Texture, content: Texture): GlassMaterialHandle {
  const backdropNode = texture(backdrop)
  const contentNode = texture(content)

  const uniforms = {
    panelSize: uniform(new Vector2(1, 1)),
    paddedSize: uniform(new Vector2(1, 1)),
    viewport: uniform(new Vector2(1, 1)),
    radius: uniform(new Vector4(28, 28, 28, 28)),
    blur: uniform(18),
    refraction: uniform(22),
    dispersion: uniform(0.25),
    tint: uniform(new Color('#ffffff')),
    tintAlpha: uniform(0.08),
    specular: uniform(0.7),
    shadow: uniform(0.4),
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

    const corner = cornerRadius(local)
    const q = local.abs().sub(half).add(corner)
    const distance = length(max(q, vec2(0))).add(min(max(q.x, q.y), float(0))).sub(corner)
    const inside = float(1).sub(smoothstep(-1, 1, distance))
    const thickness = max(uniforms.refraction.mul(1.2), 1)
    const depth = clamp(distance.negate().div(thickness), 0, 1)
    const edge = float(1).sub(depth)

    const negative = float(-1)
    const positive = float(1)
    const signVector = joinVec2(
      select(local.x.lessThan(0), negative, positive),
      select(local.y.lessThan(0), negative, positive),
    )
    const outside = max(q, vec2(0))
    const normalVector = outside.mul(signVector as never)
    const normalLength = length(normalVector)
    const normal = select(
      normalLength.greaterThan(0.0001),
      normalVector.div(max(normalLength, 0.0001)),
      vec2(0),
    ) as unknown as ReturnType<typeof vec2>

    const bend = pow(edge, 1.6).mul(uniforms.refraction).negate()
    const offset = normal.mul(bend).div(uniforms.viewport)
    const center = screenUV.add(offset)
    const spread = vec2(
      uniforms.blur.div(uniforms.viewport.x),
      uniforms.blur.div(uniforms.viewport.y),
    )
    const dispersed = uniforms.dispersion.mul(0.08)

    const sharp = vec3(
      backdropNode.sample(screenUV.add(offset.mul(float(1).add(dispersed)))).r,
      backdropNode.sample(center).g,
      backdropNode.sample(screenUV.add(offset.mul(float(1).sub(dispersed)))).b,
    )

    const tap = (x: number, y: number, weight: number) =>
      backdropNode.sample(center.add(vec2(spread.x.mul(x), spread.y.mul(y)))).rgb.mul(weight)

    const blurred = tap(0, 0, 0.16)
      .add(tap(1, 0, 0.08))
      .add(tap(-1, 0, 0.08))
      .add(tap(0, 1, 0.08))
      .add(tap(0, -1, 0.08))
      .add(tap(0.7, 0.7, 0.06))
      .add(tap(-0.7, 0.7, 0.06))
      .add(tap(0.7, -0.7, 0.06))
      .add(tap(-0.7, -0.7, 0.06))
      .add(tap(1.8, 0, 0.045))
      .add(tap(-1.8, 0, 0.045))
      .add(tap(0, 1.8, 0.045))
      .add(tap(0, -1.8, 0.045))
      .add(tap(1.3, 1.3, 0.025))
      .add(tap(-1.3, 1.3, 0.025))
      .add(tap(1.3, -1.3, 0.025))
      .add(tap(-1.3, -1.3, 0.025))

    const frosted = mix(sharp, blurred, depth)
    const tinted = mix(frosted, uniforms.tint, uniforms.tintAlpha)
    const rim = pow(edge, 4).mul(uniforms.specular).mul(0.8)
    const glare = pow(max(dot(normal, lightDirection), 0), 8)
      .mul(pow(edge, 2))
      .mul(uniforms.specular)
      .mul(0.9)
    const shade = pow(max(dot(normal, lightDirection.negate()), 0), 5).mul(0.12)
    const glass = tinted.mul(float(1).sub(shade))
      .add(vec3(1).mul(rim))
      .add(shineColor.mul(glare))

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
