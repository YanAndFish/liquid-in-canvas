/** 把 0–1 的 sRGB 分量解码为线性值。 */
export function srgbToLinear(value: number): number {
  return value < 0.04045
    ? value * 0.0773993808
    : (value * 0.9478672986 + 0.0521327014) ** 2.4
}

/** 把 `#rrggbb` 解码为线性 RGB。着色器在线性空间混合，画布视图在写入时重新编码。 */
export function hexToLinear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [
    srgbToLinear((value >> 16 & 255) / 255),
    srgbToLinear((value >> 8 & 255) / 255),
    srgbToLinear((value & 255) / 255),
  ]
}

const linearTints = new Map<string, readonly [number, number, number]>()

/**
 * `hexToLinear()` 的缓存版本，供每帧写入染色时使用。染色值来自属性与默认参数，种类很少；
 * 第一次遇到某个颜色时解析并缓存，之后只是一次查表。
 */
export function linearTint(hex: string): readonly [number, number, number] {
  let tint = linearTints.get(hex)
  if (!tint) {
    tint = hexToLinear(hex)
    linearTints.set(hex, tint)
  }
  return tint
}
