const HIGH = 4294967296

export const STAMP_BYTES = 16

export function readSpanMs(readback: GPUBuffer): number {
  const stamps = new Uint32Array(readback.getMappedRange(0, STAMP_BYTES))
  const ns = (stamps[3]! - stamps[1]!) * HIGH + (stamps[2]! - stamps[0]!)
  readback.unmap()
  return ns / 1e6
}
