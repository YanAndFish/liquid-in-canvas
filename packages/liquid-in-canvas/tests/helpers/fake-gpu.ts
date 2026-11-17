import { vi } from 'vitest'
import { StageGpu } from '../../src/gpu'

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
    createCommandEncoder: vi.fn(() => ({})),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
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

export function createFakeGpu() {
  const fake = createFakeDevice()
  const gpu = new StageGpu(fake.device, 'bgra8unorm-srgb')
  return { gpu, ...fake }
}
