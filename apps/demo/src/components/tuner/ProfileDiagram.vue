<script setup lang="ts">
import type { GlassProfileOptions } from 'liquid-in-canvas'
import { glassProfile, glassProfileOutline } from 'liquid-in-canvas'
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'
import { traceProfileRays } from './profile-rays'

const props = defineProps<{
  /** 当前材质的截面参数。 */
  material: GlassProfileOptions
  /** 玻璃底面到背景平面的距离。 */
  elevation: number
}>()

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

const { isChinese } = useLocale()

const profile = computed(() => glassProfile(props.material))

const scene = computed(() => {
  const p = profile.value
  const bottomWidth = p.bevelWidth * p.bottomBevel
  const top = props.elevation + p.halfDepth * 2
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
  const outline = glassProfileOutline(p, props.elevation, reach)
  const glassPath = `${outline.map(([x, z], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(2)} ${sz(z).toFixed(2)}`).join(' ')} Z`
  // 光线只铺在倒角和紧邻的一段平面上，平面部分的光线笔直穿过，画几条就够。
  const span = Math.max(p.bevelWidth, bottomWidth) * 1.3
  const starts = Array.from({ length: RAY_COUNT }, (_, i) => (i + 0.5) / RAY_COUNT * span)
  const rays = traceProfileRays(outline, starts, top + sky).map(ray => ({
    path: ray.points.map(([x, z], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(2)} ${sz(z).toFixed(2)}`).join(' '),
    landing: ray.landing && {
      x: sx(ray.landing),
      z: sz(0),
    },
  }))
  const bevelBottom = Math.max(0.5, p.bevelHeight * p.bottomBevel)
  return {
    glassPath,
    rays,
    ground: sz(0),
    outlineX: sx(0),
    fadeStart: sx(reach * 0.72),
    right: sx(reach),
    topBox: {
      x: sx(0),
      y: sz(top),
      width: p.bevelWidth * scale,
      height: p.bevelHeight * scale,
    },
    bottomBox: p.bottomBevel > 0
      ? {
          x: sx(0),
          y: sz(props.elevation + bevelBottom),
          width: bottomWidth * scale,
          height: bevelBottom * scale,
        }
      : null,
    elevation: {
      x: sx(reach * 0.88),
      top: sz(props.elevation),
      bottom: sz(0),
    },
  }
})

/** 实际尺寸的说明，取整到像素。 */
const legend = computed(() => {
  const p = profile.value
  const px = (value: number): string => `${Math.round(value)}px`
  return isChinese.value
    ? [`厚度 ${px(p.halfDepth * 2)}`, `倒角 ${px(p.bevelWidth)} × ${px(p.bevelHeight)}`, `悬浮 ${px(props.elevation)}`]
    : [`Thickness ${px(p.halfDepth * 2)}`, `Bevel ${px(p.bevelWidth)} × ${px(p.bevelHeight)}`, `Elevation ${px(props.elevation)}`]
})
</script>

<template>
  <figure class="profile">
    <svg
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      :aria-label="isChinese ? '玻璃边缘的截面与折射光路' : 'Cross-section of the glass edge with refracted rays'"
    >
      <defs>
        <linearGradient id="profile-fade" gradientUnits="userSpaceOnUse" :x1="scene.fadeStart" :x2="scene.right" y1="0" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="1" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <mask id="profile-mask" maskUnits="userSpaceOnUse" x="0" y="0" :width="WIDTH" :height="HEIGHT">
          <rect x="0" y="0" :width="scene.fadeStart" :height="HEIGHT" fill="#fff" />
          <rect :x="scene.fadeStart" y="0" :width="WIDTH - scene.fadeStart" :height="HEIGHT" fill="url(#profile-fade)" />
        </mask>
        <pattern id="profile-ground" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="profile-hatch" />
        </pattern>
      </defs>

      <rect x="0" :y="scene.ground" :width="WIDTH" :height="HEIGHT - scene.ground" fill="url(#profile-ground)" />
      <line x1="0" :x2="WIDTH" :y1="scene.ground" :y2="scene.ground" class="profile-ground" />

      <g mask="url(#profile-mask)">
        <path :d="scene.glassPath" class="profile-glass" />
        <rect v-bind="scene.topBox" class="profile-guide" />
        <rect v-if="scene.bottomBox" v-bind="scene.bottomBox" class="profile-guide" />
        <path v-for="(ray, i) in scene.rays" :key="i" :d="ray.path" class="profile-ray" />
      </g>
      <template v-for="(ray, i) in scene.rays" :key="`dot-${i}`">
        <circle v-if="ray.landing" :cx="ray.landing.x" :cy="ray.landing.z" r="1.6" class="profile-dot" />
      </template>

      <line :x1="scene.elevation.x" :x2="scene.elevation.x" :y1="scene.elevation.top" :y2="scene.elevation.bottom" class="profile-measure" />
      <line :x1="scene.outlineX" :x2="scene.outlineX" :y1="PAD.top" :y2="scene.ground" class="profile-axis" />
      <text :x="scene.outlineX - 4" :y="HEIGHT - 4" text-anchor="end" class="profile-label">{{ isChinese ? '外' : 'out' }}</text>
      <text :x="scene.outlineX + 4" :y="HEIGHT - 4" class="profile-label">{{ isChinese ? '背景平面 · 内 →' : 'backdrop · in →' }}</text>
    </svg>
    <figcaption>
      <span v-for="item in legend" :key="item">{{ item }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.profile { margin-top: 12px; padding: 8px 8px 7px; border: 1px solid var(--line); border-radius: 14px; background: var(--inset); }
.profile svg { display: block; width: 100%; height: auto; overflow: visible; }
.profile-glass { fill: var(--accent-soft); stroke: var(--text); stroke-width: 1.2; stroke-linejoin: round; }
.profile-guide { fill: none; stroke: var(--line-strong); stroke-width: 0.8; stroke-dasharray: 2 2; }
.profile-ray { fill: none; stroke: var(--accent-line); stroke-width: 0.9; }
.profile-dot { fill: var(--accent); }
.profile-ground { stroke: var(--line-strong); stroke-width: 1; }
.profile-hatch { stroke: var(--line); stroke-width: 1; }
.profile-axis { stroke: var(--line); stroke-width: 0.8; stroke-dasharray: 1 3; }
.profile-measure { stroke: var(--line-strong); stroke-width: 0.8; stroke-dasharray: 2 2; }
.profile-label { font-size: 8px; fill: var(--muted); }
.profile figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 8px; margin-top: 6px; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--text-soft); }
</style>
