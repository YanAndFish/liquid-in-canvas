import { describe, expect, it, vi } from 'vitest'
import { createElementTexture } from '../../src/gpu'
import { snapshotChanged, StageFrame } from '../../src/stage-frame.hot'
import { createFakeGpu } from '../helpers/fake-gpu'

/** 带 `changedElements` 的 `paint` 事件。 */
function paintEvent(changed: Element[] | undefined): Event {
  const event = new Event('paint')
  if (changed) {
    Object.defineProperty(event, 'changedElements', {
      value: Object.freeze(changed),
    })
  }
  return event
}

describe('snapshotChanged', () => {
  const root = document.createElement('div')
  const glass = document.createElement('button')

  it('没有事件或浏览器不提供 changedElements 时当作变了', () => {
    expect(snapshotChanged(undefined, root)).toBe(true)
    expect(snapshotChanged(paintEvent(undefined), root)).toBe(true)
  })

  it('只有列表里有根元素时才算变了', () => {
    expect(snapshotChanged(paintEvent([]), root)).toBe(false)
    expect(snapshotChanged(paintEvent([glass]), root)).toBe(false)
    expect(snapshotChanged(paintEvent([glass, root]), root)).toBe(true)
  })
})

describe('快照复用：StageFrame', () => {
  function setup() {
    const { gpu, device, uploads } = createFakeGpu()
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    }
    vi.mocked(device.createCommandEncoder).mockImplementation(() => ({
      beginRenderPass: vi.fn(() => pass),
      finish: vi.fn(() => ({})),
    }) as unknown as GPUCommandEncoder)
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    const context = {
      getCurrentTexture: () => ({
        createView: () => ({}),
      }),
    } as unknown as GPUCanvasContext
    const frame = new StageFrame(gpu, context, canvas)
    const root = document.createElement('div')
    const page = createElementTexture(gpu, 800, 600)
    return { frame, root, page, uploads, pass }
  }

  it('upload 为 false 时不上传整页，仍然画出页面', () => {
    const { frame, root, page, uploads, pass } = setup()
    frame.draw(root, page, 1, undefined, true)
    expect(uploads).toEqual([root])
    const draws = pass.draw.mock.calls.length

    frame.draw(root, page, 1, paintEvent([]), false)
    expect(uploads).toEqual([root])
    // 页面仍然从快照纹理画进画布。
    expect(pass.draw.mock.calls.length).toBe(draws * 2)
  })
})
