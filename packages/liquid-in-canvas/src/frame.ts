export const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  QUERY_RESOLVE: 0x0200,
} as const

export const UNIFORM_WINDOW = 65536
export const UNIFORM_ALIGN_FLOATS = 64
export const HEADER_FLOATS = 8

export const CLEAR_BLACK: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 }
export const CLEAR_TRANSPARENT: GPUColorDict = { r: 0, g: 0, b: 0, a: 0 }

export const CLEAR_FIELD: GPUColorDict = { r: 0, g: 0, b: 0, a: -1 }

export interface DrawItem {
  order: number
  pipeline: GPURenderPipeline
  uniform: number
  textures: GPUBindGroup
}

export interface UniformBinding {
  buffer: GPUBuffer
  group: GPUBindGroup
  size: number
}

export function createFieldAttachments(): GPURenderPassColorAttachment[] {
  return Array.from({ length: 3 }, () => ({
    view: null as unknown as GPUTextureView,
    loadOp: 'clear' as const,
    storeOp: 'store' as const,
    clearValue: CLEAR_FIELD,
  }))
}

export function createDrawItem(): DrawItem {
  return {
    order: 0,
    pipeline: null as unknown as GPURenderPipeline,
    uniform: 0,
    textures: null as unknown as GPUBindGroup,
  }
}

export function growFloat32(data: Float32Array, keep: number, needed: number): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(Math.max(needed, data.length * 2))
  grown.set(data.subarray(0, keep))
  return grown
}

export function createUniformBinding(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  sampler: GPUSampler,
  size: number,
  previous: UniformBinding | null,
): UniformBinding {
  previous?.buffer.destroy()
  const buffer = device.createBuffer({
    size,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  })
  const group = device.createBindGroup({
    layout,
    entries: [
      {
        binding: 0,
        resource: { buffer, offset: 0, size: UNIFORM_WINDOW },
      },
      { binding: 1, resource: sampler },
    ],
  })
  return { buffer, group, size }
}
