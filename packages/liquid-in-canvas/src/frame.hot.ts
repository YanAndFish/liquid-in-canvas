import type { DrawItem, UniformBinding } from './frame'
import type { PassTimer } from './gpu'
import type { GpuSpan } from './gpu-span.hot'
import { CLEAR_BLACK, createDrawItem, createFieldAttachments, createUniformBinding, growFloat32, UNIFORM_ALIGN_FLOATS, UNIFORM_WINDOW } from './frame'

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

export class FrameEncoder {
  data = new Float32Array(8192)
  private used = 0
  private binding: UniformBinding | null = null
  private readonly device: GPUDevice
  private readonly layout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  private readonly timing: PassTimer
  private readonly span: GpuSpan
  private readonly offsets = new Uint32Array(1)
  private readonly attachment: GPURenderPassColorAttachment
  private readonly pass: GPURenderPassDescriptor
  private readonly fieldAttachments: GPURenderPassColorAttachment[]
  private readonly fieldPass: GPURenderPassDescriptor
  private readonly commands: GPUCommandBuffer[] = []
  private readonly uploadSize = { width: 1, height: 1 }
  private readonly uploadSource: GPUElementImageSource
  private readonly uploadTarget: GPUElementImageDestination

  constructor(device: GPUDevice, layout: GPUBindGroupLayout, sampler: GPUSampler, timing: PassTimer, span: GpuSpan) {
    this.device = device
    this.layout = layout
    this.sampler = sampler
    this.timing = timing
    this.span = span
    this.attachment = {
      view: null as unknown as GPUTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: CLEAR_BLACK,
    }
    this.pass = {
      colorAttachments: [this.attachment],
    }
    this.fieldAttachments = createFieldAttachments()
    this.fieldPass = {
      colorAttachments: this.fieldAttachments,
    }
    this.uploadSource = { source: null as unknown as Element }
    this.uploadTarget = {
      texture: null as unknown as GPUTexture,
      size: this.uploadSize,
      colorSpace: 'srgb',
    }
  }

  begin(): void {
    this.used = 0
    this.timing.begin()
    this.span.begin(this.timing.active)
  }

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

  full(floats: number, targetWidth: number, targetHeight: number): number {
    return this.rect(floats, 0, 0, 1, 1, 1, 1, targetWidth, targetHeight)
  }

  beginEncoding(): GPUCommandEncoder {
    const required = this.data.length * 4 + UNIFORM_WINDOW
    if (!this.binding || this.binding.size < required)
      this.binding = createUniformBinding(this.device, this.layout, this.sampler, required, this.binding)
    if (this.used > 0)
      this.device.queue.writeBuffer(this.binding.buffer, 0, this.data.buffer, this.data.byteOffset, this.used * 4)
    return this.device.createCommandEncoder()
  }

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
    this.pass.timestampWrites = this.timing.writes(label, width, height) ?? this.span.writes()
    this.drawList(encoder.beginRenderPass(this.pass), uniforms, list)
  }

  encodeFieldPass(encoder: GPUCommandEncoder, views: readonly GPUTextureView[], width: number, height: number, list: DrawList): void {
    const uniforms = this.binding?.group
    if (!uniforms)
      throw new Error('FrameEncoder.beginEncoding() must be called before encodeFieldPass()')
    const attachments = this.fieldAttachments
    for (let i = 0; i < attachments.length; i++)
      attachments[i]!.view = views[i]!
    this.fieldPass.timestampWrites = this.timing.writes('field', width, height) ?? this.span.writes()
    this.drawList(encoder.beginRenderPass(this.fieldPass), uniforms, list)
  }

  private drawList(pass: GPURenderPassEncoder, uniforms: GPUBindGroup, list: DrawList): void {
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

  submit(encoder: GPUCommandEncoder): void {
    this.timing.finish(encoder)
    this.span.finish(encoder)
    this.commands[0] = encoder.finish()
    this.device.queue.submit(this.commands)
    this.timing.collect()
    this.span.collect()
  }

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
