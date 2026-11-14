/**
 * 每帧编码用到的常量、类型和冷路径。
 *
 * `frame.hot.ts` 里的代码每帧执行，不能分配；需要分配的事情（对象池扩容、uniform 缓冲变大）
 * 写在这里，只在少见情况下被调用。
 */

/** WebGPU 规范规定的缓冲用途标志。写成常量后，没有 GPU 全局对象的环境（单元测试）也能加载这些模块。 */
export const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  QUERY_RESOLVE: 0x0200,
} as const

/** uniform 绑定窗口的字节数，也是单个绘制项 uniform 的上限。 */
export const UNIFORM_WINDOW = 65536
/** 动态偏移的对齐要求，规范的默认下限为 256 字节。 */
export const UNIFORM_ALIGN_FLOATS = 64
/** 只含矩形与目标尺寸的 uniform 的长度。 */
export const HEADER_FLOATS = 8

/** 清成不透明的黑色。 */
export const CLEAR_BLACK: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 }
/** 清成全透明，离屏目标里按普通混合叠加后得到预乘颜色。 */
export const CLEAR_TRANSPARENT: GPUColorDict = { r: 0, g: 0, b: 0, a: 0 }

/** 画布遍或离屏遍中的一次矩形绘制。对象由 `DrawList` 复用，不要在列表之外保留引用。 */
export interface DrawItem {
  /** 绘制顺序，见 `render-order.ts`。同一遍内按从小到大绘制。 */
  order: number
  pipeline: GPURenderPipeline
  /** uniform 在本帧缓冲中的字节偏移。 */
  uniform: number
  /** 第 1 组绑定：这次绘制取样的纹理。 */
  textures: GPUBindGroup
}

/** 一块 uniform 缓冲及绑定它的第 0 组绑定。 */
export interface UniformBinding {
  buffer: GPUBuffer
  group: GPUBindGroup
  size: number
}

/** 冷路径：为绘制列表扩容时创建一个空的绘制项。 */
export function createDrawItem(): DrawItem {
  return {
    order: 0,
    pipeline: null as unknown as GPURenderPipeline,
    uniform: 0,
    textures: null as unknown as GPUBindGroup,
  }
}

/** 冷路径：把 uniform 数据扩容到至少 `needed` 个浮点数，保留前 `keep` 个。 */
export function growFloat32(data: Float32Array, keep: number, needed: number): Float32Array<ArrayBuffer> {
  const grown = new Float32Array(Math.max(needed, data.length * 2))
  grown.set(data.subarray(0, keep))
  return grown
}

/** 冷路径：创建至少 `size` 字节的 uniform 缓冲及其绑定，并释放原来的缓冲。 */
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
