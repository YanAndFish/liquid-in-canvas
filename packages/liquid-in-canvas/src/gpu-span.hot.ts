import { BUFFER_USAGE } from './frame'
import { readSpanMs, STAMP_BYTES } from './gpu-span'

const EVERY = 4
const MAP_MODE_READ = 1
const MAX_MS = 1000

export class GpuSpan {
  enabled = false
  ms = 0
  samples = 0
  private fresh = false
  private readonly querySet: GPUQuerySet | null
  private readonly resolve: GPUBuffer | null
  private readonly readback: GPUBuffer | null
  private readonly first: GPURenderPassTimestampWrites | undefined
  private readonly rest: GPURenderPassTimestampWrites | undefined
  private frames = 0
  private passes = 0
  private sampling = false
  private busy = false
  private disposed = false

  constructor(device: GPUDevice) {
    const querySet = device.features.has('timestamp-query')
      ? device.createQuerySet({ type: 'timestamp', count: 2 })
      : null
    this.querySet = querySet
    this.resolve = querySet
      ? device.createBuffer({ size: STAMP_BYTES, usage: BUFFER_USAGE.QUERY_RESOLVE | BUFFER_USAGE.COPY_SRC })
      : null
    this.readback = querySet
      ? device.createBuffer({ size: STAMP_BYTES, usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST })
      : null
    this.first = querySet
      ? { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
      : undefined
    this.rest = querySet
      ? { querySet, endOfPassWriteIndex: 1 }
      : undefined
  }

  begin(blocked: boolean): void {
    this.passes = 0
    this.sampling = false
    if (!this.enabled || blocked || !this.querySet || this.busy || this.disposed)
      return
    if (++this.frames < EVERY)
      return
    this.frames = 0
    this.sampling = true
  }

  writes(): GPURenderPassTimestampWrites | undefined {
    if (!this.sampling)
      return undefined
    return this.passes++ === 0
      ? this.first
      : this.rest
  }

  finish(encoder: GPUCommandEncoder): void {
    if (!this.sampling)
      return
    if (this.passes === 0 || !this.querySet || !this.resolve || !this.readback) {
      this.sampling = false
      return
    }
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolve, 0)
    encoder.copyBufferToBuffer(this.resolve, 0, this.readback, 0, STAMP_BYTES)
  }

  collect(): void {
    const readback = this.readback
    if (!this.sampling || !readback)
      return
    this.sampling = false
    this.busy = true
    // eslint-disable-next-line hot/no-alloc -- mapAsync 每次返回新的 Promise，每 4 帧至多一次，且上一次读回完成之前不再采样
    readback.mapAsync(MAP_MODE_READ, 0, STAMP_BYTES).then(this.mapped, this.failed)
  }

  take(): boolean {
    const fresh = this.fresh
    this.fresh = false
    return fresh
  }

  dispose(): void {
    this.disposed = true
    this.querySet?.destroy()
    this.resolve?.destroy()
    this.readback?.destroy()
  }

  private readonly mapped = (): void => {
    const readback = this.readback
    this.busy = false
    if (this.disposed || !readback)
      return
    const ms = readSpanMs(readback)
    if (ms > 0 && ms < MAX_MS) {
      this.ms = ms
      this.samples++
      this.fresh = true
    }
  }

  private readonly failed = (): void => {
    this.busy = false
  }
}
