/// <reference path="./html-in-canvas.d.ts" />
/**
 * 舞台直接使用的 WebGPU 资源中只在初始化或少见情况下执行的部分：设备与画布配置、管线表、
 * 元素纹理与离屏目标。每帧的 uniform、绘制列表与编码在 `frame.hot.ts`。
 *
 * 所有绘制都是一个矩形加一段 uniform：顶点着色器按 uniform 开头的 NDC 矩形生成四个顶点，
 * 不需要顶点缓冲，也没有场景图。一帧内的全部 uniform 写进同一块缓冲，只上传一次。
 */

import { BUFFER_USAGE } from './frame'
import { FrameEncoder } from './frame.hot'

/** WebGPU 规范规定的用途标志。写成常量后，没有 GPU 全局对象的环境（单元测试）也能加载这些模块。 */
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

/** HTML 快照的格式。浏览器写入 sRGB 编码的颜色，取样时由硬件解码为线性值。 */
export const ELEMENT_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb'
/** 离屏目标的格式：线性颜色，半精度。 */
export const TARGET_FORMAT: GPUTextureFormat = 'rgba16float'

/** 普通透明混合：片元输出未预乘的颜色。 */
export const BLEND_NORMAL: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/** 预乘混合：片元输出已经乘过 alpha 的颜色。 */
export const BLEND_PREMULTIPLIED: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/**
 * 所有着色器共用的开头：uniform 的前两个向量、取样器和矩形顶点着色器。
 *
 * - `rect`：矩形在裁剪空间中的左、上、右、下。
 * - `screen`：绘制目标的像素宽高，以及视口的 CSS 宽高。
 *
 * `uv` 以矩形左上角为原点；`position.xy / screen.xy` 是目标上的归一化坐标，同样以左上角为原点。
 * `fields` 是这两个向量之后的字段，`declarations` 是这些字段用到的结构体。
 */
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

/** 把数字写成 WGSL 的浮点字面量。 */
export function wgslFloat(value: number): string {
  return Number.isInteger(value)
    ? value.toFixed(1)
    : String(value)
}

/** 一遍绘制的计时结果。 */
export interface PassTiming {
  /** 这一遍的用途：`backdrop`、`blur`、`band` 或 `canvas`。 */
  label: string
  /** 绘制目标的像素尺寸。 */
  target: [number, number]
  /** 从开始到结束的时间，毫秒。同一命令缓冲里相互依赖的遍会重叠，逐遍相加会重复计算等待。 */
  ms: number
  /** 开始与结束相对本帧第一遍开始的时间，毫秒。整帧 GPU 时间取最后一遍的结束。 */
  begin: number
  end: number
}

const TIMING_PASSES = 48

/**
 * 逐遍的 GPU 计时，只在性能测量页打开。
 *
 * 需要 `timestamp-query` 特性；设备不支持时 `enabled` 始终为 false。上一帧的结果还没读回时跳过当前帧。
 */
export class PassTimer {
  /** 测量页设为 true 后开始计时。 */
  enabled = false
  /** 每读回一帧调用一次。 */
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

  begin(): void {
    this.passes = []
    this.recording = this.enabled && this.querySet !== null && !this.busy
  }

  /** 返回这一遍的时间戳写入位置；不计时的时候返回 undefined。 */
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

  /** 在提交前把查询结果复制到可读回的缓冲。 */
  finish(encoder: GPUCommandEncoder): void {
    if (!this.recording || !this.querySet || !this.resolve || !this.readback || !this.passes.length)
      return
    const bytes = this.passes.length * 16
    encoder.resolveQuerySet(this.querySet, 0, this.passes.length * 2, this.resolve, 0)
    encoder.copyBufferToBuffer(this.resolve, 0, this.readback, 0, bytes)
  }

  /** 提交之后读回本帧的时间。 */
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

/** 创建管线所需的描述。布局与顶点阶段由 `StageGpu` 补全。 */
export interface PipelineSpec {
  /** 完整的 WGSL，包含 `shaderPrelude()`。 */
  code: string
  /** 片元入口。 */
  entry: string
  /** 取样的纹理数量。 */
  textures: number
  format: GPUTextureFormat
  blend?: GPUBlendState
}

/** 绘制目标的格式位置：画布或离屏目标。管线表按它取用对应格式的管线。 */
export const SLOT_CANVAS = 0
export const SLOT_TARGET = 1

/** 着色器取样的纹理数量对应的绑定布局。 */
interface TextureLayout {
  bindGroup: GPUBindGroupLayout
  pipeline: GPUPipelineLayout
}

/**
 * 按整数下标缓存的一组管线，例如按体积组的成员数量、按内容的遮挡数量。
 *
 * `get()` 的快速路径只是一次数组读取，可以在每帧的代码里调用；同一个下标只编译一次，
 * 滚动中成员或遮挡数量变化只会取用已有的管线。
 */
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

  /** 取得第 `index` 条管线，没有时同步编译。 */
  get(index: number): GPURenderPipeline {
    return this.pipelines[index] ?? this.create(index)
  }

  /**
   * 在后台编译一条稍后可能用到的管线，避免第一次绘制时卡顿。
   * 编译完成前如果已经被 `get()` 同步创建，后台的结果直接丢弃。
   */
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

/** 把整张纹理画到目标上：页面快照、前景层、低分辨率体积的分块合成。 */
const BLIT_SHADER = /* wgsl */`${shaderPrelude('')}
@group(1) @binding(0) var source: texture_2d<f32>;

// 不透明地铺满矩形，用于页面快照。
@fragment
fn opaque(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(textureSample(source, samp, in.uv).rgb, 1.0);
}

// 带透明度的整层，用于前景层。
@fragment
fn layer(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(source, samp, in.uv);
}

// 按目标上的位置取样，用于把低分辨率的离屏结果分块放大回画布。
@fragment
fn screen(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(source, samp, in.position.xy / u.screen.xy);
}
`

/** 舞台的 GPU 上下文：设备、共用的绑定布局、管线编译与本帧的编码器。 */
export class StageGpu {
  readonly device: GPUDevice
  /** 画布视图的格式，带 sRGB 编码。 */
  readonly canvasFormat: GPUTextureFormat
  readonly timing: PassTimer
  /** 每帧的 uniform、绘制列表编码与元素上传。 */
  readonly frame: FrameEncoder
  /** 把整张纹理画到目标上，按格式位置取用，见 `BLIT_SHADER`。 */
  readonly blitOpaque: PipelineTable
  readonly blitLayer: PipelineTable
  readonly blitScreen: PipelineTable
  disposed = false
  private readonly sampler: GPUSampler
  private readonly uniformLayout: GPUBindGroupLayout
  private readonly textureLayouts = new Map<number, TextureLayout>()
  private readonly modules = new Map<string, GPUShaderModule>()
  private readonly textureGroups = new WeakMap<GPUTextureView, GPUBindGroup>()

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device
    this.canvasFormat = canvasFormat
    // HTML 快照与离屏目标都只有一级，放大和缩小都用线性插值，边缘取最近的纹素。
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
    this.frame = new FrameEncoder(device, this.uniformLayout, this.sampler, this.timing)
    const blit = (kind: 'opaque' | 'layer' | 'screen', blend: GPUBlendState | undefined) => new PipelineTable(this, `blit:${kind}`, slot => ({
      code: BLIT_SHADER,
      entry: kind,
      textures: 1,
      format: this.formatOf(slot),
      blend,
    }))
    this.blitOpaque = blit('opaque', undefined)
    this.blitLayer = blit('layer', BLEND_NORMAL)
    // 离屏目标里已经是预乘颜色。
    this.blitScreen = blit('screen', BLEND_PREMULTIPLIED)
  }

  /** 格式位置对应的纹理格式。 */
  formatOf(slot: number): GPUTextureFormat {
    return slot === SLOT_CANVAS
      ? this.canvasFormat
      : TARGET_FORMAT
  }

  /** 同步编译一条管线。 */
  compile(label: string, spec: PipelineSpec): GPURenderPipeline {
    return this.device.createRenderPipeline(this.descriptor(label, spec))
  }

  /** 在后台编译一条管线；不支持异步编译时返回 null。 */
  compileAsync(label: string, spec: PipelineSpec): Promise<GPURenderPipeline> | null {
    if (this.disposed || typeof this.device.createRenderPipelineAsync !== 'function')
      return null
    return this.device.createRenderPipelineAsync(this.descriptor(label, spec))
  }

  /** 只取样一张纹理的绘制项使用的绑定，按视图缓存。 */
  textureGroup(view: GPUTextureView): GPUBindGroup {
    let group = this.textureGroups.get(view)
    if (!group) {
      group = this.textureGroupOf([view])
      this.textureGroups.set(view, group)
    }
    return group
  }

  /** 为一组纹理创建绑定，由调用方缓存。 */
  textureGroupOf(views: readonly GPUTextureView[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.textureLayout(views.length).bindGroup,
      entries: views.map((view, binding) => ({ binding, resource: view })),
    })
  }

  dispose(): void {
    this.disposed = true
    this.frame.dispose()
    this.timing.dispose()
    this.modules.clear()
  }

  private textureLayout(count: number): TextureLayout {
    let layout = this.textureLayouts.get(count)
    if (!layout) {
      const bindGroup = this.device.createBindGroupLayout({
        entries: Array.from({ length: count }, (_, binding) => ({
          binding,
          visibility: SHADER_STAGE.FRAGMENT,
          texture: { sampleType: 'float' as const },
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
      this.textureLayouts.set(count, layout)
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
      layout: this.textureLayout(spec.textures).pipeline,
      vertex: { module, entryPoint: 'vertex' },
      fragment: {
        module,
        entryPoint: spec.entry,
        targets: [
          { format: spec.format, blend: spec.blend },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    }
  }
}

/** 画布的 WebGPU 上下文与设备。 */
export interface StageDevice {
  device: GPUDevice
  context: GPUCanvasContext
  /** 画布视图的格式。 */
  format: GPUTextureFormat
}

/**
 * 取得设备并配置画布。
 *
 * WebGPU 不允许把画布配置成 sRGB 格式，但允许 8 位画布使用 sRGB 视图。这里让每帧的画布纹理
 * 以 sRGB 视图接收绘制：混合在线性空间进行，硬件在写入时编码，不需要额外的颜色转换遍。
 */
export async function createStageDevice(canvas: HTMLCanvasElement): Promise<StageDevice> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu)
    throw new Error('WebGPU unavailable')
  const adapter = await gpu.requestAdapter()
  if (!adapter)
    throw new Error('WebGPU adapter unavailable')
  // 时间戳查询只用于性能测量页，设备不支持也不影响绘制。
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
  // 首选格式不是 8 位时（例如高动态范围显示器）仍然使用 8 位画布，页面快照本身就是 8 位 sRGB。
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

/** 一张可取样的纹理：纹理本身、整张视图，以及只取样它的绘制项使用的绑定。 */
export interface SampledTexture {
  texture: GPUTexture
  view: GPUTextureView
  group: GPUBindGroup
}

/** 接收 HTML 快照的纹理。 */
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

/** 创建可由 `drawElementImageToTexture()` 写入的 sRGB 纹理。 */
export function createElementTexture(gpu: StageGpu, width: number, height: number): ElementTexture {
  return createSampled(gpu, width, height, ELEMENT_FORMAT, TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT)
}

/** 释放纹理。 */
export function disposeElementTexture(target: SampledTexture | null): void {
  target?.texture.destroy()
}

/** 可以改变尺寸的离屏绘制目标。 */
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

  /** 只取样这个目标的绘制项使用的绑定。 */
  get group(): GPUBindGroup {
    return this.current.group
  }

  /** 调整尺寸。尺寸变化时重新创建纹理并返回 true，原有内容丢失。 */
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
