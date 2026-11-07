import type { Texture, WebGPURenderer } from 'three/webgpu'
import { Fn, texture, uniform, uv, vec3, vec4 } from 'three/tsl'
import {
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  RenderTarget,
  Scene,
  Vector2,
} from 'three/webgpu'
import { BLUR_SIGMAS, gaussianKernel, incrementalSigma } from './gaussian'

/** 一层模糊的两遍绘制目标。 */
interface BlurLevel {
  /** 目标标准差，单位为 CSS 像素。 */
  sigma: number
  /** 横向卷积结果。 */
  horizontal: RenderTarget
  /** 纵向卷积结果，也是供玻璃采样的最终纹理。 */
  vertical: RenderTarget
}

/** 创建无需深度缓存的线性颜色纹理。 */
function createTarget(): RenderTarget {
  return new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType })
}

/** 逐级卷积页面背景，生成与设备像素密度无关的高斯模糊纹理。 */
export class BackdropBlur {
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly sourceNode: ReturnType<typeof texture<'vec4'>>
  private readonly step = uniform(new Vector2())
  private readonly material: MeshBasicNodeMaterial
  private readonly mesh: Mesh
  private readonly levels: BlurLevel[] = BLUR_SIGMAS.map(sigma => ({
    sigma,
    horizontal: createTarget(),
    vertical: createTarget(),
  }))

  private readonly renderer: WebGPURenderer
  private disposed = false

  constructor(renderer: WebGPURenderer, source: Texture) {
    this.renderer = renderer
    this.sourceNode = texture(source)
    const taps = gaussianKernel()
    const colorNode = Fn(() => {
      let sum = vec3(0) as unknown as ReturnType<typeof vec3>
      for (const tap of taps) {
        const sample = this.sourceNode.sample(uv().add(this.step.mul(tap.offset))).rgb
        sum = sum.add(sample.mul(tap.weight)) as unknown as ReturnType<typeof vec3>
      }
      return vec4(sum, 1)
    })()
    this.material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, toneMapped: false })
    this.material.colorNode = colorNode
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
    geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2))
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  /** 按标准差从小到大返回模糊纹理。 */
  get textures(): Texture[] {
    return this.levels.map(level => level.vertical.texture)
  }

  /** 使用 CSS 视口尺寸计算采样间距，依次生成各级模糊。 */
  render(source: Texture, width: number, height: number): void {
    if (this.disposed || width < 1 || height < 1)
      return
    const previousTarget = this.renderer.getRenderTarget()
    let input = source
    let previousSigma = 0
    try {
      for (const level of this.levels) {
        // 上一级已移除高频细节，因此较宽的模糊可以使用较小的纹理。
        const downsample = Math.min(level.sigma, 16)
        const targetWidth = Math.max(1, Math.ceil(width / downsample))
        const targetHeight = Math.max(1, Math.ceil(height / downsample))
        level.horizontal.setSize(targetWidth, targetHeight)
        level.vertical.setSize(targetWidth, targetHeight)
        const sigma = incrementalSigma(previousSigma, level.sigma)
        this.pass(input, level.horizontal, sigma / width, 0)
        this.pass(level.horizontal.texture, level.vertical, 0, sigma / height)
        input = level.vertical.texture
        previousSigma = level.sigma
      }
    }
    finally {
      this.renderer.setRenderTarget(previousTarget)
    }
  }

  /** 释放卷积材质、几何体与所有模糊纹理。 */
  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    for (const level of this.levels) {
      level.horizontal.dispose()
      level.vertical.dispose()
    }
    this.material.dispose()
    this.mesh.geometry.dispose()
  }

  /** 沿指定方向执行一遍卷积，偏移量使用归一化纹理坐标。 */
  private pass(source: Texture, target: RenderTarget, x: number, y: number): void {
    this.sourceNode.value = source
    this.step.value.set(x, y)
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }
}
