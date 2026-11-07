import type { Texture, WebGPURenderer } from 'three/webgpu'
import {
  Fn,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
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

const TAPS = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const SIGMA = 4.5

const KERNEL = TAPS.map(offset => Math.exp(-(offset * offset) / (2 * SIGMA * SIGMA)))
const TOTAL = KERNEL[0]! + 2 * KERNEL.slice(1).reduce((sum, weight) => sum + weight, 0)

interface TargetPair {
  horizontal: RenderTarget
  vertical: RenderTarget
}

interface BlurMaterial {
  material: MeshBasicNodeMaterial
  sourceNode: ReturnType<typeof texture>
}

function createTarget(): RenderTarget {
  return new RenderTarget(1, 1, {
    depthBuffer: false,
    type: HalfFloatType,
  })
}

export class BackdropBlur {
  private readonly renderer: WebGPURenderer
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly horizontal: BlurMaterial
  private readonly vertical: BlurMaterial
  private readonly mesh: Mesh
  private readonly direction = uniform(new Vector2(1, 0))
  private readonly texel = uniform(new Vector2(1, 1))
  private readonly soft: TargetPair = {
    horizontal: createTarget(),
    vertical: createTarget(),
  }

  private readonly heavy: TargetPair = {
    horizontal: createTarget(),
    vertical: createTarget(),
  }

  private width = 0
  private height = 0
  private disposed = false

  constructor(renderer: WebGPURenderer, source: Texture) {
    this.renderer = renderer
    this.horizontal = this.createMaterial(source)
    this.vertical = this.createMaterial(this.soft.horizontal.texture)

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
    geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2))
    this.mesh = new Mesh(geometry, this.horizontal.material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  get softTexture(): Texture {
    return this.soft.vertical.texture
  }

  get heavyTexture(): Texture {
    return this.heavy.vertical.texture
  }

  render(source: Texture, width: number, height: number): void {
    if (this.disposed)
      return
    this.resize(width, height)
    if (this.width < 1 || this.height < 1)
      return

    this.horizontal.sourceNode.value = source
    this.mesh.material = this.horizontal.material
    this.pass(this.soft.horizontal, 1, 0)
    this.pass(this.soft.vertical, 0, 1)
    this.horizontal.sourceNode.value = source
    this.mesh.material = this.horizontal.material
    this.pass(this.heavy.horizontal, 1, 0)
    this.pass(this.heavy.vertical, 0, 1)
    this.renderer.setRenderTarget(null)
  }

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.renderer.setRenderTarget(null)
    this.soft.horizontal.dispose()
    this.soft.vertical.dispose()
    this.heavy.horizontal.dispose()
    this.heavy.vertical.dispose()
    this.horizontal.material.dispose()
    this.vertical.material.dispose()
    this.mesh.geometry.dispose()
  }

  private createMaterial(source: Texture): BlurMaterial {
    const sourceNode = texture(source)
    const colorNode = Fn(() => {
      const step = this.texel.mul(this.direction)
      let sum = vec3(0) as unknown as ReturnType<typeof vec3>
      for (const offset of TAPS) {
        const weight = KERNEL[offset]! / TOTAL
        sum = sum.add(sourceNode.sample(uv().add(step.mul(offset))).rgb.mul(weight)) as unknown as ReturnType<typeof vec3>
        if (offset > 0)
          sum = sum.add(sourceNode.sample(uv().sub(step.mul(offset))).rgb.mul(weight)) as unknown as ReturnType<typeof vec3>
      }
      return vec4(sum, 1)
    })()
    const material = new MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    material.colorNode = colorNode
    return { material, sourceNode }
  }

  private pass(target: RenderTarget, x: number, y: number): void {
    if (y > 0) {
      this.vertical.sourceNode.value = target === this.soft.vertical
        ? this.soft.horizontal.texture
        : this.heavy.horizontal.texture
      this.mesh.material = this.vertical.material
    }
    this.direction.value.set(x, y)
    this.texel.value.set(1 / target.width, 1 / target.height)
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }

  private resize(width: number, height: number): void {
    const nextSoftWidth = Math.max(1, Math.floor(width / 4))
    const nextSoftHeight = Math.max(1, Math.floor(height / 4))
    const nextHeavyWidth = Math.max(1, Math.floor(width / 8))
    const nextHeavyHeight = Math.max(1, Math.floor(height / 8))
    if (this.width === width && this.height === height)
      return
    this.width = width
    this.height = height
    this.soft.horizontal.setSize(nextSoftWidth, nextSoftHeight)
    this.soft.vertical.setSize(nextSoftWidth, nextSoftHeight)
    this.heavy.horizontal.setSize(nextHeavyWidth, nextHeavyHeight)
    this.heavy.vertical.setSize(nextHeavyWidth, nextHeavyHeight)
  }
}
