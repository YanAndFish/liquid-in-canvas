import { describe, expect, it, vi } from 'vitest'
import { CLEAR_BLACK, HEADER_FLOATS, UNIFORM_ALIGN_FLOATS } from '../../src/frame'
import { DrawList } from '../../src/frame.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

const pipeline = (label: string) => ({ label }) as unknown as GPURenderPipeline
const group = (label: string) => ({ label }) as unknown as GPUBindGroup

describe('每帧的绘制列表与编码', () => {
  it('按绘制顺序排列，顺序相同的保持加入的先后，并复用绘制项对象', () => {
    const list = new DrawList()
    list.push(2, pipeline('a'), 0, group('a'))
    list.push(1, pipeline('b'), 256, group('b'))
    list.push(2, pipeline('c'), 512, group('c'))
    list.push(0, pipeline('d'), 768, group('d'))
    list.arrange()
    expect(list.items.slice(0, list.count).map(item => item.uniform)).toEqual([768, 256, 0, 512])

    const objects = new Set(list.items)
    list.reset()
    list.push(5, pipeline('e'), 0, group('e'))
    expect(list.count).toBe(1)
    expect(objects.has(list.items[0]!)).toBe(true)
  })

  it('uniform 按动态偏移的要求对齐，空间不够时扩容并保留已写入的数据', () => {
    const { gpu } = createFakeGpu()
    const frame = gpu.frame
    frame.begin()
    const first = frame.full(HEADER_FLOATS, 100, 50)
    const second = frame.alloc(1)
    expect(first).toBe(0)
    expect(second).toBe(UNIFORM_ALIGN_FLOATS)
    expect(frame.data[4]).toBe(100)
    for (let i = 0; i < 200; i++)
      frame.alloc(HEADER_FLOATS)
    expect(frame.data.length).toBeGreaterThanOrEqual(202 * UNIFORM_ALIGN_FLOATS)
    expect(frame.data[4]).toBe(100)
  })

  it('编码时按顺序绘制，只在管线变化时切换，并传入每个绘制项的偏移', () => {
    const { gpu } = createFakeGpu()
    const calls: unknown[][] = []
    const pass = {
      setPipeline: vi.fn((value: unknown) => calls.push(['pipeline', value])),
      setBindGroup: vi.fn((index: number, _group: unknown, offsets?: Uint32Array) => calls.push(['group', index, offsets?.[0]])),
      draw: vi.fn(),
      end: vi.fn(),
    }
    const encoder = {
      beginRenderPass: vi.fn(() => pass),
    } as unknown as GPUCommandEncoder
    const frame = gpu.frame
    frame.begin()
    frame.beginEncoding()
    const list = new DrawList()
    const shared = pipeline('shared')
    list.push(2, shared, 512, group('x'))
    list.push(1, shared, 256, group('y'))
    frame.encodePass(encoder, 'canvas', {} as GPUTextureView, 10, 10, CLEAR_BLACK, list)
    expect(calls.filter(call => call[0] === 'pipeline')).toHaveLength(1)
    expect(calls.filter(call => call[0] === 'group' && call[1] === 0).map(call => call[2])).toEqual([256, 512])
    expect(pass.draw).toHaveBeenCalledTimes(2)
  })
})
