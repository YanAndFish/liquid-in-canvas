/// <reference path="./html-in-canvas.d.ts" />

import { BUFFER_USAGE } from './frame'
import { FrameEncoder } from './frame.hot'
import { GpuSpan } from './gpu-span.hot'

export const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
} as const

const SHADER_STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
} as const

export const ELEMENT_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb'
export const TARGET_FORMAT: GPUTextureFormat = 'rgba16float'

export const BLEND_NORMAL: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

export const BLEND_PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

export function shaderPrelude(fields: string, declarations = ''): string {
  return /* wgsl */`${declarations}
struct Uniforms {
  rect: vec4f,
  screen: vec4f,
${fields}
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  let corner = vec2f(f32(index & 1u), f32(index >> 1u));
  var out: VertexOutput;
  out.position = vec4f(mix(u.rect.xy, u.rect.zw, corner), 0.0, 1.0);
  out.uv = corner;
  return out;
}
`
}

export function wgslFloat(value: number): string {
  return Number.isInteger(value)
    ? value.toFixed(1)
    : String(value)
}

export interface PassTiming {
  label: string
  target: [number, number]
  ms: number
  begin: number
  end: number
}

const TIMING_PASSES = 48

export class PassTimer {
  enabled = false
  onFrame: ((passes: PassTiming[]) => void) | null = null
  private readonly querySet: GPUQuerySet | null
  private readonly resolve: GPUBuffer | null
  private readonly readback: GPUBuffer | null
  private passes: Pick<PassTiming, 'label' | 'target'>[] = []
  private recording = false
  private busy = false

  constructor(device: GPUDevice) {
    const supported = device.features.has('timestamp-query')
    this.querySet = supported
      ? device.createQuerySet({ type: 'timestamp', count: TIMING_PASSES * 2 })
      : null
    this.resolve = supported
      ? device.createBuffer({ size: TIMING_PASSES * 16, usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC })
      : null
    this.readback = supported
      ? device.createBuffer({ size: TIMING_PASSES * 16, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST })
      : null
  }

  get active(): boolean {
    return this.recording
  }

  begin(): void {
    this.passes = []
    this.recording = this.enabled && this.querySet !== null && !this.busy
  }

  writes(label: string, width: number, height: number): GPURenderPassTimestampWrites | undefined {
    if (!this.recording || !this.querySet || this.passes.length >= TIMING_PASSES)
      return undefined
    const index = this.passes.length
    this.passes.push({
      label,
      target: [width, height],
    })
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    }
  }

  finish(encoder: GPUCommandEncoder): void {
    if (!this.recording || !this.querySet || !this.resolve || !this.readback || !this.passes.length)
      return
    const bytes = this.passes.length * 16
    encoder.resolveQuerySet(this.querySet, 0, this.passes.length * 2, this.resolve, 0)
    encoder.copyBufferToBuffer(this.resolve, 0, this.readback, 0, bytes)
  }

  collect(): void {
    const readback = this.readback
    if (!this.recording || !readback || !this.passes.length)
      return
    const passes = this.passes
    this.busy = true
    void readback.mapAsync(1, 0, passes.length * 16).then(() => {
      const stamps = new BigInt64Array(readback.getMappedRange(0, passes.length * 16).slice(0))
      readback.unmap()
      const origin = stamps[0]!
      this.onFrame?.(passes.map((pass, i) => ({
        ...pass,
        ms: Number(stamps[i * 2 + 1]! - stamps[i * 2]!) / 1e6,
        begin: Number(stamps[i * 2]! - origin) / 1e6,
        end: Number(stamps[i * 2 + 1]! - origin) / 1e6,
      })))
    }).catch(() => {}).finally(() => {
      this.busy = false
    })
  }

  dispose(): void {
    this.querySet?.destroy()
    this.resolve?.destroy()
    this.readback?.destroy()
  }
}

export interface PipelineSpec {
  code: string
  entry: string
  textures: number
  unfilterable?: number
  format: GPUTextureFormat
  blend?: GPUBlendState
  formats?: readonly GPUTextureFormat[]
}

export const SLOT_CANVAS = 0
export const SLOT_TARGET = 1

interface TextureLayout {
  bindGroup: GPUBindGroupLayout
  pipeline: GPUPipelineLayout
}

export class PipelineTable {
  private readonly pipelines: (GPURenderPipeline | undefined)[] = []
  private readonly warming = new Set<number>()
  private readonly gpu: StageGpu
  private readonly label: string
  private readonly spec: (index: number) => PipelineSpec

  constructor(gpu: StageGpu, label: string, spec: (index: number) => PipelineSpec) {
    this.gpu = gpu
    this.label = label
    this.spec = spec
  }

  get(index: number): GPURenderPipeline {
    return this.pipelines[index] ?? this.create(index)
  }

  warm(index: number): void {
    if (this.pipelines[index] || this.warming.has(index))
      return
    const pending = this.gpu.compileAsync(`${this.label}:${index}`, this.spec(index))
    if (!pending)
      return
    this.warming.add(index)
    void pending.then((pipeline) => {
      if (!this.gpu.disposed)
        this.pipelines[index] ??= pipeline
    }).catch(() => {}).finally(() => {
      this.warming.delete(index)
    })
  }

  private create(index: number): GPURenderPipeline {
    const pipeline = this.gpu.compile(`${this.label}:${index}`, this.spec(index))
    this.pipelines[index] = pipeline
    return pipeline
  }
}

const BLIT_SHADER = /* wgsl */`${shaderPrelude('')}
@group(1) @binding(0) var source: texture_2d<f32>;

@fragment
fn opaque(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(textureSample(source, samp, in.uv).rgb, 1.0);
}

@fragment
fn layer(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(source, samp, in.uv);
}

@fragment
fn screen(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(source, samp, in.position.xy / u.screen.xy);
}

@fragment
fn screenOpaque(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(textureSample(source, samp, in.position.xy / u.screen.xy).rgb, 1.0);
}
`

export class StageGpu {
  readonly device: GPUDevice
  readonly canvasFormat: GPUTextureFormat
  readonly timing: PassTimer
  readonly span: GpuSpan
  readonly frame: FrameEncoder
  readonly blitOpaque: PipelineTable
  readonly blitLayer: PipelineTable
  readonly blitScreen: PipelineTable
  readonly blitScreenOpaque: PipelineTable
  disposed = false
  private readonly sampler: GPUSampler
  private readonly uniformLayout: GPUBindGroupLayout
  private readonly textureLayouts = new Map<number, TextureLayout>()
  private readonly modules = new Map<string, GPUShaderModule>()
  private readonly textureGroups = new WeakMap<GPUTextureView, GPUBindGroup>()

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device
    this.canvasFormat = canvasFormat
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    this.uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: SHADER_STAGE.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    })
    this.timing = new PassTimer(device)
    this.span = new GpuSpan(device)
    this.frame = new FrameEncoder(device, this.uniformLayout, this.sampler, this.timing, this.span)
    const blit = (kind: 'opaque' | 'layer' | 'screen' | 'screenOpaque', blend: GPUBlendState | undefined) => new PipelineTable(this, `blit:${kind}`, slot => ({
      code: BLIT_SHADER,
      entry: kind,
      textures: 1,
      format: this.formatOf(slot),
      blend,
    }))
    this.blitOpaque = blit('opaque', undefined)
    this.blitLayer = blit('layer', BLEND_NORMAL)
    this.blitScreen = blit('screen', BLEND_PREMULTIPLIED)
    this.blitScreenOpaque = blit('screenOpaque', undefined)
  }

  formatOf(slot: number): GPUTextureFormat {
    return slot === SLOT_CANVAS
      ? this.canvasFormat
      : TARGET_FORMAT
  }

  compile(label: string, spec: PipelineSpec): GPURenderPipeline {
    return this.device.createRenderPipeline(this.descriptor(label, spec))
  }

  compileAsync(label: string, spec: PipelineSpec): Promise<GPURenderPipeline> | null {
    if (this.disposed || typeof this.device.createRenderPipelineAsync !== 'function')
      return null
    return this.device.createRenderPipelineAsync(this.descriptor(label, spec))
  }

  textureGroup(view: GPUTextureView): GPUBindGroup {
    let group = this.textureGroups.get(view)
    if (!group) {
      group = this.textureGroupOf([view])
      this.textureGroups.set(view, group)
    }
    return group
  }

  textureGroupOf(views: readonly GPUTextureView[], unfilterable = 0): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.textureLayout(views.length, unfilterable).bindGroup,
      entries: views.map((view, binding) => ({ binding, resource: view })),
    })
  }

  dispose(): void {
    this.disposed = true
    this.frame.dispose()
    this.timing.dispose()
    this.span.dispose()
    this.modules.clear()
  }

  private textureLayout(count: number, unfilterable = 0): TextureLayout {
    const key = count + unfilterable * 64
    let layout = this.textureLayouts.get(key)
    if (!layout) {
      const bindGroup = this.device.createBindGroupLayout({
        entries: Array.from({ length: count }, (_, binding) => ({
          binding,
          visibility: SHADER_STAGE.FRAGMENT,
          texture: {
            sampleType: (unfilterable >> binding) & 1
              ? 'unfilterable-float' as const
              : 'float' as const,
          },
        })),
      })
      layout = {
        bindGroup,
        pipeline: this.device.createPipelineLayout({
          bindGroupLayouts: [
            this.uniformLayout,
            bindGroup,
          ],
        }),
      }
      this.textureLayouts.set(key, layout)
    }
    return layout
  }

  private descriptor(label: string, spec: PipelineSpec): GPURenderPipelineDescriptor {
    let module = this.modules.get(spec.code)
    if (!module) {
      module = this.device.createShaderModule({ code: spec.code })
      this.modules.set(spec.code, module)
    }
    return {
      label,
      layout: this.textureLayout(spec.textures, spec.unfilterable).pipeline,
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: spec.entry,
        targets: (spec.formats ?? [spec.format]).map(format => ({ format, blend: spec.blend })),
      },
      primitive: { topology: 'triangle-strip' },
    }
  }
}

export interface StageDevice {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
}

export async function createStageDevice(canvas: HTMLCanvasElement): Promise<StageDevice> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu)
    throw new Error('WebGPU unavailable')
  const adapter = await gpu.requestAdapter()
  if (!adapter)
    throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query')
      ? ['timestamp-query']
      : [],
  })
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context) {
    device.destroy()
    throw new Error('WebGPU canvas context unavailable')
  }
  const base: GPUTextureFormat = gpu.getPreferredCanvasFormat() === 'rgba8unorm'
    ? 'rgba8unorm'
    : 'bgra8unorm'
  const format: GPUTextureFormat = `${base}-srgb`
  context.configure({
    device,
    format: base,
    viewFormats: [format],
    usage: TEXTURE_USAGE.RENDER_ATTACHMENT,
    alphaMode: 'opaque',
  })
  return { device, context, format }
}

export interface SampledTexture {
  texture: GPUTexture
  view: GPUTextureView
  group: GPUBindGroup
}

export type ElementTexture = SampledTexture

function createSampled(gpu: StageGpu, width: number, height: number, format: GPUTextureFormat, usage: number): SampledTexture {
  const texture = gpu.device.createTexture({
    size: { width, height },
    format,
    usage,
  })
  const view = texture.createView()
  return {
    texture,
    view,
    group: gpu.textureGroup(view),
  }
}

export function createElementTexture(gpu: StageGpu, width: number, height: number): ElementTexture {
  return createSampled(gpu, width, height, ELEMENT_FORMAT, TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT)
}

export function disposeElementTexture(target: SampledTexture | null): void {
  target?.texture.destroy()
}

export class RenderTarget {
  width = 0
  height = 0
  private readonly gpu: StageGpu
  private current: SampledTexture

  constructor(gpu: StageGpu) {
    this.gpu = gpu
    this.current = this.create(1, 1)
  }

  get view(): GPUTextureView {
    return this.current.view
  }

  get group(): GPUBindGroup {
    return this.current.group
  }

  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height)
      return false
    this.current.texture.destroy()
    this.current = this.create(width, height)
    return true
  }

  dispose(): void {
    this.current.texture.destroy()
  }

  private create(width: number, height: number): SampledTexture {
    this.width = width
    this.height = height
    return createSampled(this.gpu, width, height, TARGET_FORMAT, TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.RENDER_ATTACHMENT)
  }
}
