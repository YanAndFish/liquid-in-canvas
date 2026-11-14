/// <reference path="./html-in-canvas.d.ts" />

/**
 * 舞台直接使用的 WebGPU 资源：设备与画布配置、每帧的 uniform 缓冲、管线缓存、元素纹理与离屏目标。
 *
 * 所有绘制都是一个矩形加一段 uniform：顶点着色器按 uniform 开头的 NDC 矩形生成四个顶点，
 * 不需要顶点缓冲，也没有场景图。一帧内的全部 uniform 写进同一块缓冲，只上传一次。
 */

/** WebGPU 规范规定的用途标志。写成常量后，没有 GPU 全局对象的环境（单元测试）也能加载这些模块。 */
export const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
} as const

const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  QUERY_RESOLVE: 0x0200,
} as const

const SHADER_STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
} as const

/** HTML 快照的格式。浏览器写入 sRGB 编码的颜色，取样时由硬件解码为线性值。 */
export const ELEMENT_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb'
/** 离屏目标的格式：线性颜色，半精度。 */
export const TARGET_FORMAT: GPUTextureFormat = 'rgba16float'

/** uniform 绑定窗口的字节数，也是单个绘制项 uniform 的上限。 */
const UNIFORM_WINDOW = 65536
/** 动态偏移的对齐要求，规范的默认下限为 256 字节。 */
const UNIFORM_ALIGN_FLOATS = 64

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

/** 画布遍或离屏遍中的一次矩形绘制。 */
export interface DrawItem {
  /** 绘制顺序，见 `render-order.ts`。同一遍内按从小到大绘制。 */
  order: number
  pipeline: GPURenderPipeline
  /** uniform 在本帧缓冲中的字节偏移。 */
  uniform: number
  /** 第 1 组绑定：这次绘制取样的纹理。 */
  textures: GPUBindGroup
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

/** 一帧内所有绘制项的 uniform。先在内存里写完，提交前一次上传。 */
export class UniformArena {
  /** 本帧的数据，`alloc()` 之后直接按下标写入。扩容后会换成新数组，不要跨 `alloc()` 保留引用。 */
  data = new Float32Array(8192)
  private used = 0
  private buffer: GPUBuffer | null = null
  private group: GPUBindGroup | null = null
  private readonly device: GPUDevice
  private readonly layout: GPUBindGroupLayout
  private readonly sampler: GPUSampler

  constructor(device: GPUDevice, layout: GPUBindGroupLayout, sampler: GPUSampler) {
    this.device = device
    this.layout = layout
    this.sampler = sampler
  }

  /** 开始新的一帧。 */
  reset(): void {
    this.used = 0
  }

  /** 分配 `floats` 个浮点数并清零，返回它在 `data` 中的起始下标；乘以 4 就是绘制项的字节偏移。 */
  alloc(floats: number): number {
    const start = this.used
    const end = start + Math.ceil(floats / UNIFORM_ALIGN_FLOATS) * UNIFORM_ALIGN_FLOATS
    if (end > this.data.length) {
      const grown = new Float32Array(Math.max(end, this.data.length * 2))
      grown.set(this.data.subarray(0, start))
      this.data = grown
    }
    else {
      this.data.fill(0, start, end)
    }
    this.used = end
    return start
  }

  /** 上传本帧的数据，返回第 0 组绑定。缓冲不够大时重新创建。 */
  flush(): GPUBindGroup {
    // 绑定窗口从任意绘制项的偏移开始都必须落在缓冲之内。
    const required = this.data.length * 4 + UNIFORM_WINDOW
    if (!this.buffer || this.buffer.size < required || !this.group) {
      this.buffer?.destroy()
      this.buffer = this.device.createBuffer({
        size: required,
        usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
      })
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.buffer, offset: 0, size: UNIFORM_WINDOW },
          },
          { binding: 1, resource: this.sampler },
        ],
      })
    }
    if (this.used > 0)
      this.device.queue.writeBuffer(this.buffer, 0, this.data.buffer, this.data.byteOffset, this.used * 4)
    return this.group
  }

  dispose(): void {
    this.buffer?.destroy()
    this.buffer = null
    this.group = null
  }
}

/** 着色器取样的纹理数量对应的绑定布局。 */
interface TextureLayout {
  bindGroup: GPUBindGroupLayout
  pipeline: GPUPipelineLayout
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

/** 一帧 uniform 的写入位置。 */
export interface FrameHeader {
  /** 矩形的左、上、右、下，单位为 CSS 像素。 */
  left: number
  top: number
  right: number
  bottom: number
  /** 绘制目标的像素尺寸。 */
  targetWidth: number
  targetHeight: number
  /** 视口的 CSS 尺寸。 */
  cssWidth: number
  cssHeight: number
}

/** 舞台的 GPU 上下文：设备、共用的绑定布局、管线缓存和本帧的 uniform。 */
export class StageGpu {
  readonly device: GPUDevice
  /** 画布视图的格式，带 sRGB 编码。 */
  readonly canvasFormat: GPUTextureFormat
  readonly arena: UniformArena
  readonly timing: PassTimer
  private readonly sampler: GPUSampler
  private readonly uniformLayout: GPUBindGroupLayout
  private readonly textureLayouts = new Map<number, TextureLayout>()
  private readonly modules = new Map<string, GPUShaderModule>()
  private readonly pipelines = new Map<string, GPURenderPipeline>()
  private readonly warming = new Set<string>()
  private readonly textureGroups = new WeakMap<GPUTextureView, GPUBindGroup>()
  private uniforms: GPUBindGroup | null = null
  private disposed = false

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
    this.arena = new UniformArena(device, this.uniformLayout, this.sampler)
    this.timing = new PassTimer(device)
  }

  /**
   * 按键取得管线，没有时同步创建。
   *
   * 键必须唯一确定 `create()` 的结果。同一个键只创建一次：按成员数量取用体积管线时，
   * 滚动中成员的变化不会触发着色器编译。
   */
  pipeline(key: string, create: () => PipelineSpec): GPURenderPipeline {
    let pipeline = this.pipelines.get(key)
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline(this.descriptor(key, create()))
      this.pipelines.set(key, pipeline)
    }
    return pipeline
  }

  /**
   * 在后台编译一条稍后可能用到的管线，避免第一次绘制时卡顿。
   *
   * 编译完成前如果已经被 `pipeline()` 同步创建，后台的结果直接丢弃。
   */
  warm(key: string, create: () => PipelineSpec): void {
    if (this.pipelines.has(key) || this.warming.has(key) || typeof this.device.createRenderPipelineAsync !== 'function')
      return
    this.warming.add(key)
    void this.device.createRenderPipelineAsync(this.descriptor(key, create())).then((pipeline) => {
      if (!this.disposed && !this.pipelines.has(key))
        this.pipelines.set(key, pipeline)
    }).catch(() => {}).finally(() => {
      this.warming.delete(key)
    })
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

  /**
   * 分配一个绘制项的 uniform 并写入开头的矩形与目标尺寸，返回起始下标。
   * 其余字段从下标加 8 开始，由调用方写入 `arena.data`。
   */
  allocUniform(floats: number, header: FrameHeader): number {
    const start = this.arena.alloc(floats)
    const data = this.arena.data
    data[start] = header.left / header.cssWidth * 2 - 1
    data[start + 1] = 1 - header.top / header.cssHeight * 2
    data[start + 2] = header.right / header.cssWidth * 2 - 1
    data[start + 3] = 1 - header.bottom / header.cssHeight * 2
    data[start + 4] = header.targetWidth
    data[start + 5] = header.targetHeight
    data[start + 6] = header.cssWidth
    data[start + 7] = header.cssHeight
    return start
  }

  /** 开始一帧：清空 uniform，准备计时。 */
  beginFrame(): void {
    this.arena.reset()
    this.uniforms = null
    this.timing.begin()
  }

  /** 所有绘制项的 uniform 写完后调用，上传并返回本帧的命令编码器。 */
  beginEncoding(): GPUCommandEncoder {
    this.uniforms = this.arena.flush()
    return this.device.createCommandEncoder()
  }

  /**
   * 编码一遍绘制。`clear` 为 null 时保留目标原有的内容。
   * 绘制项按 `order` 从小到大绘制，相同的保持传入顺序。
   */
  encodePass(
    encoder: GPUCommandEncoder,
    label: string,
    target: { view: GPUTextureView, width: number, height: number },
    clear: GPUColor | null,
    items: readonly DrawItem[],
  ): void {
    const uniforms = this.uniforms
    if (!uniforms)
      throw new Error('StageGpu.beginEncoding() must be called before encodePass()')
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          loadOp: clear
            ? 'clear'
            : 'load',
          clearValue: clear ?? undefined,
          storeOp: 'store',
        },
      ],
      timestampWrites: this.timing.writes(label, target.width, target.height),
    })
    let pipeline: GPURenderPipeline | null = null
    for (const item of [...items].sort((a, b) => a.order - b.order)) {
      if (item.pipeline !== pipeline) {
        pipeline = item.pipeline
        pass.setPipeline(pipeline)
      }
      pass.setBindGroup(0, uniforms, [item.uniform])
      pass.setBindGroup(1, item.textures)
      pass.draw(4)
    }
    pass.end()
  }

  /** 提交本帧的命令。 */
  submit(encoder: GPUCommandEncoder): void {
    this.timing.finish(encoder)
    this.device.queue.submit([
      encoder.finish(),
    ])
    this.timing.collect()
  }

  dispose(): void {
    this.disposed = true
    this.arena.dispose()
    this.timing.dispose()
    this.pipelines.clear()
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
          bindGroupLayouts: [this.uniformLayout, bindGroup],
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

/** 把元素的当前绘制记录写入整张纹理。 */
export function uploadElement(device: GPUDevice, element: Element, texture: GPUTexture): void {
  device.queue.drawElementImageToTexture(
    { source: element },
    {
      texture,
      size: { width: texture.width, height: texture.height },
      colorSpace: 'srgb',
    },
  )
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

/** 整张纹理的三种画法，见 `BLIT_SHADER`。 */
export type BlitKind = 'opaque' | 'layer' | 'screen'

const BLIT_BLEND: Record<BlitKind, GPUBlendState | undefined> = {
  opaque: undefined,
  layer: BLEND_NORMAL,
  // 离屏目标里已经是预乘颜色。
  screen: BLEND_PREMULTIPLIED,
}

/** 取得把一张纹理画到指定格式目标上的管线。 */
export function blitPipeline(gpu: StageGpu, kind: BlitKind, format: GPUTextureFormat): GPURenderPipeline {
  return gpu.pipeline(`blit:${kind}:${format}`, () => ({
    code: BLIT_SHADER,
    entry: kind,
    textures: 1,
    format,
    blend: BLIT_BLEND[kind],
  }))
}

/** 只含矩形与目标尺寸的 uniform 的长度。 */
export const HEADER_FLOATS = 8
