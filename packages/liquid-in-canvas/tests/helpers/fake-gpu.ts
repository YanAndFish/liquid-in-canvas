import { vi } from 'vitest'
import { StageGpu } from '../../src/gpu'

/**
 * 记录调用的假 WebGPU 设备。只实现舞台用到的方法，返回的对象都是普通对象，
 * 用来检查管线、纹理与 uniform 的分配，而不需要真正的 GPU。
 */
export function createFakeDevice() {
  const pipelines: GPURenderPipelineDescriptor[] = []
  const shaders: string[] = []
  const uploads: Element[] = []
  const device = {
    features: new Set<string>(),
    createSampler: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createShaderModule: vi.fn(({ code }: { code: string }) => {
      shaders.push(code)
      return { code }
    }),
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => {
      pipelines.push(descriptor)
      return { label: descriptor.label }
    }),
    createBuffer: vi.fn(({ size }: { size: number }) => ({
      size,
      destroy: vi.fn(),
    })),
    createTexture: vi.fn(({ size }: { size: { width: number, height: number } }) => ({
      ...size,
      createView: () => ({}),
      destroy: vi.fn(),
    })),
    queue: {
      writeBuffer: vi.fn(),
      submit: vi.fn(),
      drawElementImageToTexture: vi.fn(({ source }: { source: Element }) => {
        uploads.push(source)
      }),
    },
  }
  return {
    device: device as unknown as GPUDevice,
    pipelines,
    shaders,
    uploads,
    queue: device.queue,
  }
}

/** 用假设备创建真实的 `StageGpu`。 */
export function createFakeGpu() {
  const fake = createFakeDevice()
  const gpu = new StageGpu(fake.device, 'bgra8unorm-srgb')
  return { gpu, ...fake }
}
