export function srgbToLinear(value: number): number {
  return value < 0.04045
    ? value * 0.0773993808
    : (value * 0.9478672986 + 0.0521327014) ** 2.4
}

export function hexToLinear(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [
    srgbToLinear((value >> 16 & 255) / 255),
    srgbToLinear((value >> 8 & 255) / 255),
    srgbToLinear((value & 255) / 255),
  ]
}

const linearTints = new Map<string, readonly [number, number, number]>()

export function linearTint(hex: string): readonly [number, number, number] {
  let tint = linearTints.get(hex)
  if (!tint) {
    tint = hexToLinear(hex)
    linearTints.set(hex, tint)
  }
  return tint
}
