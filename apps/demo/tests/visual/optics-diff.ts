import { HEADER_FLOATS } from '../../../../packages/liquid-in-canvas/src/frame'
import { DrawList } from '../../../../packages/liquid-in-canvas/src/frame.hot'
/**
 * 光路对照：不经过 HTML-in-Canvas，直接用库里的体积着色器在一张静态背景上画同一组玻璃，
 * 比较三维求交、混合光路（逐帧求交 / 读折射场缓存）与剖面查表的画面，并给出逐像素差异。
 *
 * 只需要 WebGPU，不需要 `drawElementImageToTexture()`，可以在不支持 HTML-in-Canvas 的浏览器里检查光路。
 *
 * 查询参数：
 * - `dx`、`dy`：圆形中心相对胶囊右端圆心的偏移（CSS 像素），缺省是演示里调参按钮贴着「浏览系列」的位置。
 * - `scale`：显示倍数。
 * - `clip`：胶囊的裁剪框右边相对胶囊右端的位置，缺省不裁剪。
 */
import { SLOT_CANVAS, StageGpu, TEXTURE_USAGE } from '../../../../packages/liquid-in-canvas/src/gpu'
import { linearTint, srgbToLinear } from '../../../../packages/liquid-in-canvas/src/liquid-glass/color'
import { createFieldTextures } from '../../../../packages/liquid-in-canvas/src/liquid-glass/field-cache'
import { BLUR_SIGMAS } from '../../../../packages/liquid-in-canvas/src/liquid-glass/gaussian'
import { ProfileTable } from '../../../../packages/liquid-in-canvas/src/liquid-glass/optics-lut'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from '../../../../packages/liquid-in-canvas/src/liquid-glass/profile'
import { bindVolumeTextures, createFieldBakePipelines, createVolumePipelines, VOLUME_GROUP_FLOATS, VOLUME_MEMBER_FLOATS } from '../../../../packages/liquid-in-canvas/src/liquid-glass/volume-shader'

interface Glass {
  x: number
  y: number
  width: number
  height: number
  radius: number
  fusion: number
  clip: [number, number, number, number]
  blur: number
  refraction: number
  tint: string
  tintAlpha: number
  specular: number
  saturation: number
  dispersion: number
  lens: number
}

const query = new URLSearchParams(location.search)
const W = 520
const H = 300
const scale = Number(query.get('scale') ?? 2)
const capsule: Glass = {
  x: 40,
  y: 70,
  width: 292,
  height: 76,
  radius: 38,
  fusion: 32,
  clip: [-1e5, -1e5, 1e5, 1e5],
  blur: 0,
  refraction: 80,
  tint: '#131b20',
  tintAlpha: 0.1,
  specular: 0.9,
  saturation: 1.15,
  dispersion: 0.05,
  lens: 0,
}
const dx = Number(query.get('dx') ?? 66)
const dy = Number(query.get('dy') ?? 42)
const circleCenterX = capsule.x + capsule.width - capsule.height / 2 + dx
const circleCenterY = capsule.y + capsule.height / 2 + dy
const circle: Glass = {
  ...capsule,
  x: circleCenterX - 32,
  y: circleCenterY - 32,
  width: 64,
  height: 64,
  radius: 32,
  fusion: 40,
  tint: '#ffffff',
  tintAlpha: 0.01,
}
if (query.has('clip')) {
  capsule.clip = [
    -1e5,
    -1e5,
    capsule.x + capsule.width + Number(query.get('clip')),
    1e5,
  ]
}
if (query.has('circleDepth'))
  circle.refraction = Number(query.get('circleDepth'))
const depthOverride = new Map<Glass, number>()
if (query.has('depth')) {
  depthOverride.set(capsule, Number(query.get('depth')))
  depthOverride.set(circle, Number(query.get('depth')))
}
const glasses = [capsule, circle]
const crop = (query.get('crop') ?? '').split(',').map(Number)

function halfDepthOf(glass: Glass): number {
  return depthOverride.get(glass) ?? profileHalfDepth(glass.refraction, glass.width, glass.height)
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  return createImageBitmap(await response.blob())
}

async function main(): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter()
  const device = await adapter!.requestDevice()
  const format: GPUTextureFormat = 'rgba8unorm-srgb'
  const gpu = new StageGpu(device, format)

  // 背景：海报按高度铺满，取中间一段。
  const poster = await loadImage('/media/liquid-glass-flower-poster.jpg')
  const source = device.createTexture({
    size: { width: W, height: H },
    format: 'rgba8unorm-srgb',
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT,
  })
  const backdrop = new OffscreenCanvas(W, H)
  const context = backdrop.getContext('2d')!
  const ratio = Math.max(W / poster.width, H / poster.height) * 1.6
  context.drawImage(poster, (W - poster.width * ratio) / 2 - 80, (H - poster.height * ratio) / 2, poster.width * ratio, poster.height * ratio)
  device.queue.copyExternalImageToTexture({ source: backdrop }, { texture: source }, { width: W, height: H })
  const sourceView = source.createView()
  // 各级模糊都绑定原图：对照只关心光路，不关心模糊。
  const blurs = BLUR_SIGMAS.map(() => sourceView)

  const profiles = new ProfileTable(gpu)
  const floats = HEADER_FLOATS + VOLUME_GROUP_FLOATS + glasses.length * VOLUME_MEMBER_FLOATS

  /** 按 `writeVolumeGroup()` 的布局写一组玻璃的 uniform。 */
  function writeGroup(data: Float32Array, group: number): void {
    let fusion = 0
    let highest = 0
    for (const glass of glasses) {
      const halfDepth = halfDepthOf(glass)
      fusion = Math.max(fusion, glass.fusion)
      highest = Math.max(highest, 16 + halfDepth * 2 + glass.fusion)
    }
    const count = glasses.length
    data[group] = highest + 4
    data[group + 1] = fusion * 2 * (1 + count / 4) + 1
    data[group + 2] = srgbToLinear(1)
    data[group + 3] = fusion * 2 * (1 + Math.max(0, count - 2) / 4) + 1
    data[group + 4] = 0.12
    data[group + 5] = 28
    data[group + 8] = 0
    data[group + 9] = 0
    data[group + 10] = 1
    data[group + 11] = 1
    data[group + 12] = 0
    data[group + 13] = 0
    data[group + 14] = 1
    data[group + 15] = 1
    let offset = group + VOLUME_GROUP_FLOATS
    for (const glass of glasses) {
      const halfDepth = halfDepthOf(glass)
      const tint = linearTint(glass.tint)
      data[offset] = glass.x + glass.width / 2
      data[offset + 1] = glass.y + glass.height / 2
      data[offset + 2] = glass.width / 2
      data[offset + 3] = glass.height / 2
      for (let k = 4; k < 8; k++)
        data[offset + k] = Math.min(glass.radius, glass.width / 2, glass.height / 2)
      data[offset + 8] = halfDepth
      data[offset + 9] = 16
      data[offset + 10] = glass.fusion
      data[offset + 11] = glass.lens
      data.set(glass.clip, offset + 12)
      data[offset + 16] = glass.blur * glass.blur
      data[offset + 17] = glass.dispersion
      data[offset + 18] = glass.tintAlpha
      data[offset + 19] = glass.specular
      data[offset + 20] = tint[0] * glass.tintAlpha
      data[offset + 21] = tint[1] * glass.tintAlpha
      data[offset + 22] = tint[2] * glass.tintAlpha
      data[offset + 23] = 1
      data[offset + 24] = profileBevelWidth(halfDepth, 0.8)
      data[offset + 25] = profileBevelHeight(halfDepth, 1)
      data[offset + 26] = 2.75
      data[offset + 27] = 1
      const bevelWidth = Math.max(Math.min(data[offset + 24]!, data[offset + 2]!, data[offset + 3]!), 0.5)
      data[offset + 28] = profiles.rowOf(bevelWidth / halfDepth, data[offset + 25]! / halfDepth, 2.75, 1, glass.dispersion)
      data[offset + 29] = glass.saturation
      data[offset + 30] = 1
      offset += VOLUME_MEMBER_FLOATS
    }
  }

  const kinds = [
    'raymarch',
    'hybrid',
    'field',
    'profile',
  ] as const
  const tables = Object.fromEntries(kinds.map(kind => [kind, createVolumePipelines(gpu, kind)[SLOT_CANVAS]!]))
  const bake = createFieldBakePipelines(gpu)
  const fields = createFieldTextures(gpu, W, H)
  const plain = bindVolumeTextures(gpu, sourceView, blurs, 0, profiles.view).group
  const raw = bindVolumeTextures(gpu, sourceView, blurs, 0).group
  const cached = bindVolumeTextures(gpu, sourceView, blurs, 0, profiles.view, fields.views).group

  const frame = gpu.frame
  frame.begin()
  const background = frame.full(HEADER_FLOATS, W, H)
  const starts: Record<string, number> = {}
  for (const kind of kinds) {
    const start = frame.rect(floats, 0, 0, W, H, W, H, W, H)
    writeGroup(frame.data, start + HEADER_FLOATS)
    starts[kind] = start
  }
  const bakeStart = frame.full(floats, W, H)
  writeGroup(frame.data, bakeStart + HEADER_FLOATS)
  frame.data[bakeStart + 6] = W
  frame.data[bakeStart + 7] = H

  const encoder = frame.beginEncoding()
  const bakeList = new DrawList()
  bakeList.push(0, bake.get(glasses.length), bakeStart * 4, plain)
  frame.encodeFieldPass(encoder, fields.views, W, H, bakeList)

  const targets: Record<string, GPUTexture> = {}
  const rowBytes = Math.ceil(W * 4 / 256) * 256
  const buffers: Record<string, GPUBuffer> = {}
  for (const kind of kinds) {
    const target = device.createTexture({
      size: { width: W, height: H },
      format,
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
    })
    targets[kind] = target
    const list = new DrawList()
    list.push(0, gpu.blitOpaque.get(SLOT_CANVAS), background * 4, gpu.textureGroup(sourceView))
    const textures = kind === 'raymarch'
      ? raw
      : kind === 'field'
        ? cached
        : plain
    list.push(1, tables[kind]!.get(glasses.length), starts[kind]! * 4, textures)
    frame.encodePass(encoder, kind, target.createView(), W, H, { r: 0, g: 0, b: 0, a: 1 }, list)
    const buffer = device.createBuffer({ size: rowBytes * H, usage: 0x08 /* COPY_DST */ | 0x01 /* MAP_READ */ })
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: rowBytes }, { width: W, height: H })
    buffers[kind] = buffer
  }
  device.queue.submit([
    encoder.finish(),
  ])

  const pixels: Record<string, Uint8ClampedArray> = {}
  for (const kind of kinds) {
    await buffers[kind]!.mapAsync(1 /* GPUMapMode.READ */)
    const mapped = new Uint8Array(buffers[kind]!.getMappedRange())
    const out = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++)
      out.set(mapped.subarray(y * rowBytes, y * rowBytes + W * 4), y * W * 4)
    pixels[kind] = out
  }

  const grid = document.getElementById('grid')!
  function show(label: string, data: Uint8ClampedArray): void {
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = label
    const canvas = document.createElement('canvas')
    const [x, y, w, h] = crop.length === 4
      ? crop
      : [0, 0, W, H]
    canvas.width = w!
    canvas.height = h!
    canvas.style.width = `${w! * scale / 2}px`
    canvas.style.height = `${h! * scale / 2}px`
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), -x!, -y!, x!, y!, w!, h!)
    figure.append(caption, canvas)
    grid.append(figure)
  }

  const reference = pixels.raymarch!
  const lines: string[] = [`几何：胶囊 ${capsule.width}×${capsule.height}，圆形中心相对胶囊右端圆心 (${dx}, ${dy})`]
  const stats: Record<string, { mean: number, max: number, over: number }> = {}
  show('raymarch（参照）', reference)
  for (const kind of ['hybrid', 'field', 'profile']) {
    const data = pixels[kind]!
    const diff = new Uint8ClampedArray(W * H * 4)
    let sum = 0
    let max = 0
    let over = 0
    for (let i = 0; i < W * H; i++) {
      let d = 0
      for (let c = 0; c < 3; c++)
        d = Math.max(d, Math.abs(data[i * 4 + c]! - reference[i * 4 + c]!))
      sum += d
      max = Math.max(max, d)
      if (d > 8)
        over++
      const v = Math.min(255, d * 4)
      diff[i * 4] = v
      diff[i * 4 + 1] = v > 32
        ? 0
        : v
      diff[i * 4 + 2] = 0
      diff[i * 4 + 3] = 255
    }
    stats[kind] = { mean: sum / (W * H), max, over }
    lines.push(`${kind}: 平均差 ${(sum / (W * H)).toFixed(3)}，最大差 ${max}，差 > 8 的像素 ${over}`)
    show(kind, data)
    show(`${kind} − raymarch（×4）`, diff)
  }
  document.getElementById('stats')!.textContent = lines.join('\n');
  (window as unknown as { opticsDiff: unknown }).opticsDiff = stats
}

main().catch((error: unknown) => {
  document.getElementById('stats')!.textContent = String(error instanceof Error
    ? error.stack
    : error)
})
