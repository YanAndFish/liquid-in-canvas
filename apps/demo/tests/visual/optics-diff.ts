import { HEADER_FLOATS } from '../../../../packages/liquid-in-canvas/src/frame'
import { DrawList } from '../../../../packages/liquid-in-canvas/src/frame.hot'
import { SLOT_CANVAS, StageGpu, TEXTURE_USAGE } from '../../../../packages/liquid-in-canvas/src/gpu'
import { linearTint, srgbToLinear } from '../../../../packages/liquid-in-canvas/src/liquid-glass/color'
import { createFieldTextures } from '../../../../packages/liquid-in-canvas/src/liquid-glass/field-cache'
import { BLUR_SIGMAS } from '../../../../packages/liquid-in-canvas/src/liquid-glass/gaussian'
import { ProfileTable } from '../../../../packages/liquid-in-canvas/src/liquid-glass/optics-lut'
import { profileBevelHeight, profileBevelWidth, profileHalfDepth } from '../../../../packages/liquid-in-canvas/src/liquid-glass/profile'
import { writeFusionProximity } from '../../../../packages/liquid-in-canvas/src/liquid-glass/volume-members.hot'
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
const square = query.get('scene') === 'square'
const W = square ? 360 : 520
const H = square ? 400 : 300
const ratio = Number(query.get('ratio') ?? 1)
const scale = Number(query.get('scale') ?? 2)
const capsule: Glass = square
  ? {
      x: 80,
      y: 60,
      width: 200,
      height: 200,
      radius: 28,
      fusion: 32,
      clip: [-1e5, -1e5, 1e5, 1e5],
      blur: 0,
      refraction: 80,
      tint: '#f6f6f8',
      tintAlpha: 0.1,
      specular: 0.7,
      saturation: 1.3,
      dispersion: 0.05,
      lens: 0,
    }
  : {
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
for (const key of [
  'width',
  'height',
  'radius',
  'refraction',
] as const) {
  if (query.has(key))
    capsule[key] = Number(query.get(key))
}
const dx = Number(query.get('dx') ?? (square
  ? -47
  : 66))
const dy = Number(query.get('dy') ?? (square ? 155 : 42))
const circleCenterX = square
  ? capsule.x + capsule.width / 2 + dx
  : capsule.x + capsule.width - capsule.height / 2 + dx
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
  specular: 0.9,
  saturation: 1.15,
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
const glasses = query.has('alone')
  ? [capsule]
  : [capsule, circle]
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

  const PW = Math.round(W * ratio)
  const PH = Math.round(H * ratio)
  const source = device.createTexture({
    size: { width: PW, height: PH },
    format: 'rgba8unorm-srgb',
    usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT,
  })
  const backdrop = new OffscreenCanvas(PW, PH)
  const context = backdrop.getContext('2d')!
  context.scale(ratio, ratio)
  if (square) {
    const colors = [
      '#ff5f6d',
      '#ffc36a',
      '#4ecdc4',
      '#7c5cff',
    ]
    context.save()
    context.translate(W / 2, H / 2)
    context.rotate(-Math.PI / 4)
    for (let i = -40; i < 40; i++) {
      context.fillStyle = colors[(i + 400) % colors.length]!
      context.fillRect(i * 22, -H * 2, 22, H * 4)
    }
    context.restore()
  }
  else {
    const poster = await loadImage('/media/liquid-glass-flower-poster.jpg')
    const fit = Math.max(W / poster.width, H / poster.height) * 1.6
    context.drawImage(poster, (W - poster.width * fit) / 2 - 80, (H - poster.height * fit) / 2, poster.width * fit, poster.height * fit)
  }
  device.queue.copyExternalImageToTexture({ source: backdrop }, { texture: source }, { width: PW, height: PH })
  const sourceView = source.createView()
  const blurs = BLUR_SIGMAS.map(() => sourceView)

  const profiles = new ProfileTable(gpu)
  const floats = HEADER_FLOATS + VOLUME_GROUP_FLOATS + glasses.length * VOLUME_MEMBER_FLOATS

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
    writeFusionProximity(data, group + VOLUME_GROUP_FLOATS, count)
  }

  const kinds = [
    'raymarch',
    'hybrid',
    'field',
    'profile',
  ] as const
  const tables = Object.fromEntries(kinds.map(kind => [kind, createVolumePipelines(gpu, kind)[SLOT_CANVAS]!]))
  const bake = createFieldBakePipelines(gpu)
  const fields = createFieldTextures(gpu, PW, PH)
  const plain = bindVolumeTextures(gpu, sourceView, blurs, 0, profiles.view).group
  const raw = bindVolumeTextures(gpu, sourceView, blurs, 0).group
  const cached = bindVolumeTextures(gpu, sourceView, blurs, 0, profiles.view, fields.views).group

  const frame = gpu.frame
  frame.begin()
  const background = frame.full(HEADER_FLOATS, PW, PH)
  const starts: Record<string, number> = {}
  for (const kind of kinds) {
    const start = frame.rect(floats, 0, 0, W, H, W, H, PW, PH)
    writeGroup(frame.data, start + HEADER_FLOATS)
    starts[kind] = start
  }
  const bakeStart = frame.full(floats, PW, PH)
  writeGroup(frame.data, bakeStart + HEADER_FLOATS)
  frame.data[bakeStart + 4] = PW
  frame.data[bakeStart + 5] = PH
  frame.data[bakeStart + 6] = W
  frame.data[bakeStart + 7] = H

  const encoder = frame.beginEncoding()
  const bakeList = new DrawList()
  bakeList.push(0, bake.get(glasses.length), bakeStart * 4, plain)
  frame.encodeFieldPass(encoder, fields.views, PW, PH, bakeList)

  const targets: Record<string, GPUTexture> = {}
  const rowBytes = Math.ceil(PW * 4 / 256) * 256
  const buffers: Record<string, GPUBuffer> = {}
  for (const kind of kinds) {
    const target = device.createTexture({
      size: { width: PW, height: PH },
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
    frame.encodePass(encoder, kind, target.createView(), PW, PH, { r: 0, g: 0, b: 0, a: 1 }, list)
    const buffer = device.createBuffer({ size: rowBytes * PH, usage: 0x08 | 0x01 })
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: rowBytes }, { width: PW, height: PH })
    buffers[kind] = buffer
  }
  device.queue.submit([
    encoder.finish(),
  ])

  const pixels: Record<string, Uint8ClampedArray> = {}
  for (const kind of kinds) {
    await buffers[kind]!.mapAsync(1)
    const mapped = new Uint8Array(buffers[kind]!.getMappedRange())
    const out = new Uint8ClampedArray(PW * PH * 4)
    for (let y = 0; y < PH; y++)
      out.set(mapped.subarray(y * rowBytes, y * rowBytes + PW * 4), y * PW * 4)
    pixels[kind] = out
  }

  const grid = document.getElementById('grid')!
  function show(label: string, data: Uint8ClampedArray): void {
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = label
    const canvas = document.createElement('canvas')
    const [x, y, w, h] = (crop.length === 4
      ? crop
      : [0, 0, W, H]).map(value => Math.round(value * ratio))
    canvas.width = w!
    canvas.height = h!
    canvas.style.width = `${w! * scale / 2 / ratio}px`
    canvas.style.height = `${h! * scale / 2 / ratio}px`
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), PW, PH), -x!, -y!, x!, y!, w!, h!)
    figure.append(caption, canvas)
    grid.append(figure)
  }

  const reference = pixels.raymarch!
  const lines: string[] = [`几何：${square ? '方块' : '胶囊'} ${capsule.width}×${capsule.height}，圆形中心偏移 (${dx}, ${dy})${glasses.length === 1
    ? '（不画圆形）'
    : ''}`]
  const stats: Record<string, { mean: number, max: number, over: number }> = {}
  show('raymarch（参照）', reference)
  for (const kind of ['hybrid', 'field', 'profile']) {
    const data = pixels[kind]!
    const diff = new Uint8ClampedArray(PW * PH * 4)
    let sum = 0
    let max = 0
    let over = 0
    for (let i = 0; i < PW * PH; i++) {
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
    stats[kind] = { mean: sum / (PW * PH), max, over }
    lines.push(`${kind}: 平均差 ${(sum / (PW * PH)).toFixed(3)}，最大差 ${max}，差 > 8 的像素 ${over}`)
    show(kind, data)
    show(`${kind} − raymarch（×4）`, diff)
  }
  document.getElementById('stats')!.textContent = lines.join('\n');
  (window as unknown as { opticsDiff: unknown }).opticsDiff = stats;
  (window as unknown as { opticsPixels: unknown }).opticsPixels = { pixels, width: PW, height: PH, ratio }
}

main().catch((error: unknown) => {
  document.getElementById('stats')!.textContent = String(error instanceof Error
    ? error.stack
    : error)
})
