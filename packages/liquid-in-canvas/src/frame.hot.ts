import type { DrawItem, UniformBinding } from './frame'
import type { PassTimer } from './gpu'
import { CLEAR_BLACK, createDrawItem, createUniformBinding, growFloat32, UNIFORM_ALIGN_FLOATS, UNIFORM_WINDOW } from './frame'

/**
 * 一遍绘制的绘制项列表。对象在列表里复用，每帧 `reset()` 后重新填写。
 */
export class DrawList {
  readonly items: DrawItem[] = []
  count = 0

  reset(): void {
    this.count = 0
  }

  push(order: number, pipeline: GPURenderPipeline, uniform: number, textures: GPUBindGroup): void {
    const item = this.items[this.count] ?? this.grow()
    item.order = order
    item.pipeline = pipeline
    item.uniform = uniform
    item.textures = textures
    this.count++
  }

  /** 按绘制顺序排列，顺序相同的保持加入的先后。插入排序：项数很少，而且不分配。 */
  arrange(): void {
    const items = this.items
    for (let i = 1; i < this.count; i++) {
      const item = items[i]!
      let j = i - 1
      while (j >= 0 && items[j]!.order > item.order) {
        items[j + 1] = items[j]!
        j--
      }
      items[j + 1] = item
    }
  }

  private grow(): DrawItem {
    const item = createDrawItem()
    this.items[this.count] = item
    return item
  }
}

/**
 * 一帧的 uniform、命令编码与元素上传。
 *
 * 一帧内所有绘制项的 uniform 先写进 `data`，提交前一次上传，绘制时用动态偏移切换。
 * 渲染遍描述、动态偏移和元素上传的参数对象都在构造时创建，每次调用只改写字段。
 */
export class FrameEncoder {
  /** 本帧的 uniform 数据，`alloc()` 之后直接按下标写入。扩容后会换成新数组，不要跨 `alloc()` 保留引用。 */
  data = new Float32Array(8192)
  private used = 0
  private binding: UniformBinding | null = null
  private readonly device: GPUDevice
  private readonly layout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  private readonly timing: PassTimer
  private readonly offsets = new Uint32Array(1)
  private readonly attachment: GPURenderPassColorAttachment
  private readonly pass: GPURenderPassDescriptor
  private readonly commands: GPUCommandBuffer[] = []
  private readonly uploadSize = { width: 1, height: 1 }
  private readonly uploadSource: GPUElementImageSource
  private readonly uploadTarget: GPUElementImageDestination

  constructor(device: GPUDevice, layout: GPUBindGroupLayout, sampler: GPUSampler, timing: PassTimer) {
    this.device = device
    this.layout = layout
    this.sampler = sampler
    this.timing = timing
    this.attachment = {
      view: null as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: CLEAR_BLACK,
    }
    this.pass = {
      colorAttachments: [this.attachment],
    }
    this.uploadSource = { source: null as unknown as Element }
    this.uploadTarget = {
      texture: null as unknown as GPUTexture,
      size: this.uploadSize,
      colorSpace: 'srgb',
    }
  }

  /** 开始新的一帧。 */
  begin(): void {
    this.used = 0
    this.timing.begin()
  }

  /** 分配 `floats` 个浮点数并清零，返回它在 `data` 中的起始下标；乘以 4 就是绘制项的字节偏移。 */
  alloc(floats: number): number {
    const start = this.used
    const end = start + Math.ceil(floats / UNIFORM_ALIGN_FLOATS) * UNIFORM_ALIGN_FLOATS
    if (end > this.data.length)
      this.data = growFloat32(this.data, start, end)
    else
      this.data.fill(0, start, end)
    this.used = end
    return start
  }

  /**
   * 分配一个绘制项的 uniform 并写入开头的矩形与目标尺寸，返回起始下标。
   * 矩形用 CSS 像素，其余字段从下标加 8 开始，由调用方写入 `data`。
   */
  rect(
    floats: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    cssWidth: number,
    cssHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): number {
    const start = this.alloc(floats)
    const data = this.data
    data[start] = left / cssWidth * 2 - 1
    data[start + 1] = 1 - top / cssHeight * 2
    data[start + 2] = right / cssWidth * 2 - 1
    data[start + 3] = 1 - bottom / cssHeight * 2
    data[start + 4] = targetWidth
    data[start + 5] = targetHeight
    data[start + 6] = cssWidth
    data[start + 7] = cssHeight
    return start
  }

  /** 铺满整个目标的绘制项。 */
  full(floats: number, targetWidth: number, targetHeight: number): number {
    return this.rect(floats, 0, 0, 1, 1, 1, 1, targetWidth, targetHeight)
  }

  /** 所有绘制项的 uniform 写完后调用，上传并返回本帧的命令编码器。 */
  beginEncoding(): GPUCommandEncoder {
    // 绑定窗口从任意绘制项的偏移开始都必须落在缓冲之内。
    const required = this.data.length * 4 + UNIFORM_WINDOW
    if (!this.binding || this.binding.size < required)
      this.binding = createUniformBinding(this.device, this.layout, this.sampler, required, this.binding)
    if (this.used > 0)
      this.device.queue.writeBuffer(this.binding.buffer, 0, this.data.buffer, this.data.byteOffset, this.used * 4)
    return this.device.createCommandEncoder()
  }

  /**
   * 编码一遍绘制。`clear` 为 null 时保留目标原有的内容。
   * 绘制项按 `order` 从小到大绘制，相同的保持加入顺序。
   */
  encodePass(
    encoder: GPUCommandEncoder,
    label: string,
    view: GPUTextureView,
    width: number,
    height: number,
    clear: GPUColorDict | null,
    list: DrawList,
  ): void {
    const uniforms = this.binding?.group
    if (!uniforms)
      throw new Error('FrameEncoder.beginEncoding() must be called before encodePass()')
    const attachment = this.attachment
    attachment.view = view
    attachment.loadOp = clear
      ? 'clear'
      : 'load'
    if (clear)
      attachment.clearValue = clear
    this.pass.timestampWrites = this.timing.writes(label, width, height)
    const pass = encoder.beginRenderPass(this.pass)
    list.arrange()
    const items = list.items
    const offsets = this.offsets
    let pipeline: GPURenderPipeline | null = null
    for (let i = 0; i < list.count; i++) {
      const item = items[i]!
      if (item.pipeline !== pipeline) {
        pipeline = item.pipeline
        pass.setPipeline(pipeline)
      }
      offsets[0] = item.uniform
      pass.setBindGroup(0, uniforms, offsets, 0, 1)
      pass.setBindGroup(1, item.textures)
      pass.draw(4)
    }
    pass.end()
  }

  /** 提交本帧的命令。 */
  submit(encoder: GPUCommandEncoder): void {
    this.timing.finish(encoder)
    this.commands[0] = encoder.finish()
    this.device.queue.submit(this.commands)
    this.timing.collect()
  }

  /** 把元素的当前绘制记录写入整张纹理。 */
  upload(element: Element, texture: GPUTexture): void {
    this.uploadSource.source = element
    this.uploadTarget.texture = texture
    this.uploadSize.width = texture.width
    this.uploadSize.height = texture.height
    this.device.queue.drawElementImageToTexture(this.uploadSource, this.uploadTarget)
  }

  dispose(): void {
    this.binding?.buffer.destroy()
    this.binding = null
  }
}
