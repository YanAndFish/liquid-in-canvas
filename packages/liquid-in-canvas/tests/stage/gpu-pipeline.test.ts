import { describe, expect, it, vi } from 'vitest'
import { PipelineTable } from '../../src/gpu'
import { createFakeGpu } from '../helpers/fake-gpu'

function createAsyncHarness() {
  const fake = createFakeGpu()
  const jobs: {
    label: string
    resolve: (pipeline: GPURenderPipeline) => void
    reject: (cause: unknown) => void
  }[] = []
  const createRenderPipelineAsync = vi.fn((descriptor: GPURenderPipelineDescriptor) => new Promise<GPURenderPipeline>((resolve, reject) => {
    jobs.push({
      label: String(descriptor.label),
      resolve,
      reject,
    })
  }))
  ;(fake.device as unknown as { createRenderPipelineAsync: typeof createRenderPipelineAsync }).createRenderPipelineAsync = createRenderPipelineAsync
  const table = new PipelineTable(fake.gpu, 'test', index => ({
    code: `shader-${index}`,
    entry: 'main',
    textures: 1,
    format: fake.gpu.canvasFormat,
  }))
  return {
    ...fake,
    jobs,
    createRenderPipelineAsync,
    table,
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('管线异步串行编译队列', () => {
  it('串行编译且按需推迟着色器模块创建，紧急请求可插队到普通预热之前', async () => {
    const { table, jobs, shaders } = createAsyncHarness()
    table.warm(1)
    table.warm(2)
    table.warm(3)
    expect(jobs.map(job => job.label)).toEqual(['test:1'])
    expect(shaders).toEqual(['shader-1'])

    let notified = 0
    const onReady = () => {
      notified++
    }
    expect(table.request(3, onReady)).toBeNull()
    expect(table.request(3, onReady)).toBeNull()
    expect(jobs).toHaveLength(1)

    jobs.shift()!.resolve({ label: 'test:1' } as unknown as GPURenderPipeline)
    await flush()
    expect(jobs.map(job => job.label)).toEqual(['test:3'])
    expect(shaders).toEqual(['shader-1', 'shader-3'])

    jobs.shift()!.resolve({ label: 'test:3' } as unknown as GPURenderPipeline)
    await flush()
    expect(notified).toBe(1)
    expect(table.request(3, onReady)).toEqual({ label: 'test:3' })
    expect(jobs.map(job => job.label)).toEqual(['test:2'])
  })

  it('同步获取会取消排队中的异步编译，失败后不再反复重试，销毁时清空队列', async () => {
    const { gpu, table, jobs, pipelines } = createAsyncHarness()
    table.warm(1)
    table.warm(2)
    table.warm(3)

    expect(table.get(2)).toEqual({ label: 'test:2' })
    expect(pipelines.map(pipeline => pipeline.label)).toEqual(['test:2'])

    jobs.shift()!.reject(new Error('compile failed'))
    await flush()
    expect(jobs.map(job => job.label)).toEqual(['test:3'])
    expect(table.request(1)).toBeNull()
    expect(jobs.map(job => job.label)).toEqual(['test:3'])

    table.warm(4)
    gpu.dispose()
    jobs.shift()!.resolve({ label: 'test:3' } as unknown as GPURenderPipeline)
    await flush()
    expect(jobs).toHaveLength(0)
  })
})
