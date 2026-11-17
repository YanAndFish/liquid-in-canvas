import { describe, expect, it, vi } from 'vitest'
import { GpuSpan } from '../../src/gpu-span.hot'

function createDevice(stamps: [number, number, number, number], features = ['timestamp-query']) {
  const mapped: Array<() => void> = []
  const readback = {
    mapAsync: vi.fn(() => new Promise<void>(resolve => mapped.push(resolve))),
    getMappedRange: vi.fn(() => new Uint32Array(stamps).buffer),
    unmap: vi.fn(),
    destroy: vi.fn(),
  }
  let buffers = 0
  const device = {
    features: new Set(features),
    createQuerySet: vi.fn(() => ({
      destroy: vi.fn(),
    })),
    createBuffer: vi.fn(() => ++buffers === 2
      ? readback
      : {
          destroy: vi.fn(),
        }),
  } as unknown as GPUDevice
  const encoder = {
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
  }
  return {
    device,
    readback,
    mapped,
    encoder: encoder as typeof encoder & GPUCommandEncoder,
  }
}

function frame(span: GpuSpan, encoder: GPUCommandEncoder, passes: number, blocked = false) {
  span.begin(blocked)
  const writes = []
  for (let i = 0; i < passes; i++)
    writes.push(span.writes())
  span.finish(encoder)
  span.collect()
  return writes
}

describe('整帧 GPU 跨度', () => {
  it('每 4 帧采一次：第一遍写开始与结束，其余各遍只改写结束', () => {
    const { device, encoder } = createDevice([0, 0, 0, 0])
    const span = new GpuSpan(device)
    span.enabled = true
    for (let i = 0; i < 3; i++)
      expect(frame(span, encoder, 3)).toEqual([undefined, undefined, undefined])
    const [first, second, third] = frame(span, encoder, 3)
    expect(first).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 })
    expect(second).toMatchObject({ endOfPassWriteIndex: 1 })
    expect(second).not.toHaveProperty('beginningOfPassWriteIndex')
    expect(third).toBe(second)
    expect(encoder.resolveQuerySet).toHaveBeenCalledTimes(1)
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledTimes(1)
  })

  it('读回之后给出毫秒数，跨过低 32 位也正确；读回期间不再采样', async () => {
    const { device, readback, mapped, encoder } = createDevice([4294967000, 7, 2999704, 8])
    const span = new GpuSpan(device)
    span.enabled = true
    for (let i = 0; i < 4; i++)
      frame(span, encoder, 2)
    for (let i = 0; i < 8; i++)
      expect(frame(span, encoder, 2)).toEqual([undefined, undefined])
    expect(readback.mapAsync).toHaveBeenCalledTimes(1)
    expect(span.take()).toBe(false)
    mapped[0]!()
    await Promise.resolve()
    await Promise.resolve()
    expect(span.take()).toBe(true)
    expect(span.ms).toBeCloseTo(3)
    expect(span.take()).toBe(false)
    expect(readback.unmap).toHaveBeenCalledTimes(1)
  })

  it('关闭、逐遍计时占用或设备不支持时不写时间戳', () => {
    const off = createDevice([0, 0, 0, 0])
    const disabled = new GpuSpan(off.device)
    for (let i = 0; i < 8; i++)
      expect(frame(disabled, off.encoder, 1)).toEqual([undefined])

    const busy = createDevice([0, 0, 0, 0])
    const blocked = new GpuSpan(busy.device)
    blocked.enabled = true
    for (let i = 0; i < 8; i++)
      expect(frame(blocked, busy.encoder, 1, true)).toEqual([undefined])

    const none = createDevice([0, 0, 0, 0], [])
    const unsupported = new GpuSpan(none.device)
    unsupported.enabled = true
    for (let i = 0; i < 8; i++)
      expect(frame(unsupported, none.encoder, 1)).toEqual([undefined])
    expect(none.encoder.resolveQuerySet).not.toHaveBeenCalled()
  })
})
