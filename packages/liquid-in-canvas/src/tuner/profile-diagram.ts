import type { GlassProfileOptions } from '../liquid-glass/profile'
import type { GlassTunerLocale } from './messages'
import { glassProfile, glassProfileOutline } from '../liquid-glass/profile'
import { traceProfileRays } from './profile-rays'

/** 画布尺寸与留白，单位是 SVG 用户坐标。 */
const WIDTH = 320
const HEIGHT = 210
const PAD = {
  left: 14,
  right: 8,
  top: 8,
  bottom: 16,
}
/** 轮廓外侧留出的空气宽度，单位是 SVG 用户坐标。 */
const OUTSIDE = 26
const RAY_COUNT = 11

function n(value: number): string {
  return value.toFixed(2)
}

function pathOf(points: readonly (readonly [number, number])[], sx: (x: number) => number, sz: (z: number) => number): string {
  return points.map(([x, z], i) => `${i ? 'L' : 'M'}${n(sx(x))} ${n(sz(z))}`).join(' ')
}

/**
 * 生成玻璃边缘截面图：轮廓、倒角参考框、竖直入射的折射光路与它们在背景平面上的落点。
 *
 * 返回 `<svg>` 与说明文字的 HTML。`id` 用来区分同一页面上的多张图里的渐变与遮罩。
 */
export function renderProfileDiagram(material: GlassProfileOptions, elevation: number, locale: GlassTunerLocale, id: string): string {
  const zh = locale === 'zh'
  const p = glassProfile(material)
  const bottomWidth = p.bevelWidth * p.bottomBevel
  const top = elevation + p.halfDepth * 2
  // 平面部分至少露出一段，光线偏折后的落点也在画面之内；比例尺由高度决定时，平面一直延伸到右侧。
  const inner = WIDTH - PAD.left - PAD.right - OUTSIDE
  const sky = Math.max(8, p.halfDepth * 0.35)
  const scale = Math.min(
    inner / Math.max(p.bevelWidth * 1.7, Math.max(p.bevelWidth, bottomWidth) + p.halfDepth, 32),
    (HEIGHT - PAD.top - PAD.bottom) / (top + sky),
  )
  const reach = inner / scale
  const sx = (x: number): number => PAD.left + OUTSIDE + x * scale
  const sz = (z: number): number => HEIGHT - PAD.bottom - z * scale
  const outline = glassProfileOutline(p, elevation, reach)
  // 光线只铺在倒角和紧邻的一段平面上，平面部分的光线笔直穿过，画几条就够。
  const span = Math.max(p.bevelWidth, bottomWidth) * 1.3
  const starts = Array.from({ length: RAY_COUNT }, (_, i) => (i + 0.5) / RAY_COUNT * span)
  const rays = traceProfileRays(outline, starts, top + sky, material.ior)
  const ground = sz(0)
  const outlineX = sx(0)
  const fadeStart = sx(reach * 0.72)
  const right = sx(reach)
  const bevelBottom = Math.max(0.5, p.bevelHeight * p.bottomBevel)
  const measureX = sx(reach * 0.88)
  const fade = `${id}-fade`
  const mask = `${id}-mask`
  const hatch = `${id}-ground`

  const guides = [
    `<rect x="${n(sx(0))}" y="${n(sz(top))}" width="${n(p.bevelWidth * scale)}" height="${n(p.bevelHeight * scale)}" class="lg-tuner-profile-guide"/>`,
  ]
  if (p.bottomBevel > 0)
    guides.push(`<rect x="${n(sx(0))}" y="${n(sz(elevation + bevelBottom))}" width="${n(bottomWidth * scale)}" height="${n(bevelBottom * scale)}" class="lg-tuner-profile-guide"/>`)
  const rayPaths = rays.map(ray => `<path d="${pathOf(ray.points, sx, sz)}" class="lg-tuner-profile-ray"/>`).join('')
  const dots = rays
    .filter(ray => ray.landing !== null)
    .map(ray => `<circle cx="${n(sx(ray.landing!))}" cy="${n(ground)}" r="1.6" class="lg-tuner-profile-dot"/>`)
    .join('')
  const px = (value: number): string => `${Math.round(value)}px`
  const legend = zh
    ? [`厚度 ${px(p.halfDepth * 2)}`, `倒角 ${px(p.bevelWidth)} × ${px(p.bevelHeight)}`, `悬浮 ${px(elevation)}`]
    : [`Thickness ${px(p.halfDepth * 2)}`, `Bevel ${px(p.bevelWidth)} × ${px(p.bevelHeight)}`, `Elevation ${px(elevation)}`]
  const label = zh
    ? '玻璃边缘的截面与折射光路'
    : 'Cross-section of the glass edge with refracted rays'

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label}">`
    + `<defs>`
    + `<linearGradient id="${fade}" gradientUnits="userSpaceOnUse" x1="${n(fadeStart)}" x2="${n(right)}" y1="0" y2="0">`
    + `<stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>`
    + `</linearGradient>`
    + `<mask id="${mask}" maskUnits="userSpaceOnUse" x="0" y="0" width="${WIDTH}" height="${HEIGHT}">`
    + `<rect x="0" y="0" width="${n(fadeStart)}" height="${HEIGHT}" fill="#fff"/>`
    + `<rect x="${n(fadeStart)}" y="0" width="${n(WIDTH - fadeStart)}" height="${HEIGHT}" fill="url(#${fade})"/>`
    + `</mask>`
    + `<pattern id="${hatch}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`
    + `<line x1="0" y1="0" x2="0" y2="6" class="lg-tuner-profile-hatch"/>`
    + `</pattern>`
    + `</defs>`
    + `<rect x="0" y="${n(ground)}" width="${WIDTH}" height="${n(HEIGHT - ground)}" fill="url(#${hatch})"/>`
    + `<line x1="0" x2="${WIDTH}" y1="${n(ground)}" y2="${n(ground)}" class="lg-tuner-profile-ground"/>`
    + `<g mask="url(#${mask})">`
    + `<path d="${pathOf(outline, sx, sz)} Z" class="lg-tuner-profile-glass"/>${
      guides.join('')
    }${rayPaths
    }</g>${
      dots
    }<line x1="${n(measureX)}" x2="${n(measureX)}" y1="${n(sz(elevation))}" y2="${n(ground)}" class="lg-tuner-profile-measure"/>`
    + `<line x1="${n(outlineX)}" x2="${n(outlineX)}" y1="${PAD.top}" y2="${n(ground)}" class="lg-tuner-profile-axis"/>`
    + `<text x="${n(outlineX - 4)}" y="${HEIGHT - 4}" text-anchor="end" class="lg-tuner-profile-label">${zh ? '外' : 'out'}</text>`
    + `<text x="${n(outlineX + 4)}" y="${HEIGHT - 4}" class="lg-tuner-profile-label">${zh ? '背景平面 · 内 →' : 'backdrop · in →'}</text>`
    + `</svg>`
    + `<figcaption>${legend.map(item => `<span>${item}</span>`).join('')}</figcaption>`
}
