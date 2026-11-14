<script setup lang="ts">
import type { GlassMaterial, GlassRenderMode, GlassVariant } from 'liquid-in-canvas'
import { DEFAULT_STAGE_RESOLUTION, GLASS_LIMITS, resetGlassDefaults, setGlassDefaults } from 'liquid-in-canvas'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useGlassDefaults } from '@/composables/useGlassDefaults'
import { useLocale } from '@/composables/useLocale'
import { useRenderer } from '@/composables/useRenderer'
import { useSpring } from '@/composables/useSpring'
import { useTheme } from '@/composables/useTheme'
import AppIcon from '../ui/AppIcon.vue'
import { clampLauncherPosition, tunerPanelPosition } from './position'

const props = defineProps<{
  /** 购物袋等模态界面打开时隐藏调参入口。 */
  disabled?: boolean
}>()

type MaterialNumber = Exclude<keyof GlassMaterial, 'tint'>
type ShapeNumber = 'fusion' | 'elevation' | 'radius'

/** 一个滑块的说明。 */
interface Field<Key extends string> {
  key: Key
  zh: string
  en: string
  step: number
  /** 滑块上限；缺省使用库允许的最大值。 */
  max?: number
  /** 数值后的单位。 */
  unit?: string
}

const MATERIAL_FIELDS: readonly Field<MaterialNumber>[] = [
  {
    key: 'blur',
    zh: '模糊',
    en: 'Blur',
    step: 1,
    unit: 'px',
  },
  {
    key: 'refraction',
    zh: '厚度',
    en: 'Thickness',
    step: 1,
    unit: 'px',
  },
  {
    key: 'dispersion',
    zh: '色散',
    en: 'Dispersion',
    step: 0.01,
  },
  {
    key: 'lens',
    zh: '透镜放大',
    en: 'Magnification',
    step: 0.01,
  },
  {
    key: 'tintAlpha',
    zh: '染色浓度',
    en: 'Tint amount',
    step: 0.01,
  },
  {
    key: 'specular',
    zh: '高光',
    en: 'Specular',
    step: 0.01,
  },
  {
    key: 'shadow',
    zh: '阴影',
    en: 'Shadow',
    step: 0.01,
  },
  {
    key: 'shadowSize',
    zh: '阴影范围',
    en: 'Shadow size',
    step: 1,
    unit: 'px',
  },
]
const SHAPE_FIELDS: readonly Field<ShapeNumber>[] = [
  {
    key: 'fusion',
    zh: '融合距离',
    en: 'Fusion distance',
    step: 1,
    unit: 'px',
  },
  {
    key: 'elevation',
    zh: '悬浮高度',
    en: 'Elevation',
    step: 1,
    unit: 'px',
  },
  {
    key: 'radius',
    zh: '圆角',
    en: 'Corner radius',
    step: 1,
    max: 64,
    unit: 'px',
  },
]
const VARIANTS: readonly { id: GlassVariant, zh: string, en: string }[] = [
  { id: 'regular', zh: '柔和', en: 'Regular' },
  { id: 'clear', zh: '通透', en: 'Clear' },
]
const MODES: readonly { id: GlassRenderMode, zh: string, en: string }[] = [
  { id: 'canvas', zh: '画布', en: 'Canvas' },
  { id: 'svg', zh: 'SVG 滤镜', en: 'SVG filter' },
  { id: 'css', zh: '纯 CSS', en: 'CSS only' },
]

/**
 * 面板展开时所在的玻璃层。同层玻璃会相互融合：面板很大，如果留在页面玻璃所在的第 0 层，
 * 滚到它下面的每个控件都会并入同一个融合组，整块面板逐像素求交，帧率明显下降。
 * 单独一层后只与入口按钮融合。收起时入口按钮回到第 0 层，拖到其他玻璃旁边仍然可以观察融合。
 */
const PANEL_LAYER = 1

const { isChinese } = useLocale()
const { theme } = useTheme()
const { defaults } = useGlassDefaults()
const renderer = useRenderer()
const launcher = ref<HTMLButtonElement>()
const opened = ref(false)
const dragging = ref(false)
const variant = ref<GlassVariant>('regular')
const copied = ref(false)
const ratios = ref<{ canvas: number, glass: number } | null>(null)
const viewport = ref({ x: window.innerWidth, y: window.innerHeight })
const position = ref({ x: viewport.value.x - 92, y: viewport.value.y - 92 })
const buttonSize = computed(() => viewport.value.x < 600
  ? 56
  : 64)
const panelSize = computed(() => ({
  x: Math.min(360, viewport.value.x - 24),
  y: Math.min(620, viewport.value.y - buttonSize.value - 48),
}))
const panelPosition = computed(() => tunerPanelPosition(position.value, viewport.value, panelSize.value, buttonSize.value))
const progress = useSpring(() => opened.value ? 1 : 0)
const visible = computed(() => opened.value || progress.value > 0.002)
const ready = computed(() => opened.value && progress.value >= 0.98)
const panelStyle = computed(() => {
  const t = Math.max(0, Math.min(1, progress.value))
  return {
    left: `${position.value.x + (panelPosition.value.x - position.value.x) * t}px`,
    top: `${position.value.y + (panelPosition.value.y - position.value.y) * t}px`,
    width: `${buttonSize.value + (panelSize.value.x - buttonSize.value) * t}px`,
    height: `${buttonSize.value + (panelSize.value.y - buttonSize.value) * t}px`,
  }
})
const material = computed(() => defaults.value.materials[variant.value][theme.value])
const canvasActive = computed(() => renderer?.mode.value === 'canvas')
let suppressClick = false
let gesture: { pointerId: number, startX: number, startY: number, left: number, top: number } | null = null
let copyTimer: ReturnType<typeof setTimeout> | undefined
let ratioTimer: ReturnType<typeof setInterval> | undefined

/** 按当前语言取文案。 */
function tr(zh: string, en: string): string {
  return isChinese.value
    ? zh
    : en
}

/** 小数步长保留两位，整数步长不带小数。 */
function format(value: number, field: Field<string>): string {
  return `${field.step < 1
    ? value.toFixed(2)
    : Math.round(value)}${field.unit ?? ''}`
}

function inputNumber(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

/** 修改当前主题下所选材质的一项参数。 */
function setMaterial(key: keyof GlassMaterial, value: number | string): void {
  setGlassDefaults({
    materials: {
      [variant.value]: {
        [theme.value]: { [key]: value },
      },
    },
  })
}

function setShape(key: ShapeNumber, value: number): void {
  setGlassDefaults({ [key]: value })
}

/** 恢复库内置的玻璃参数与分辨率限制。 */
function reset(): void {
  resetGlassDefaults()
  renderer?.setResolution({ ...DEFAULT_STAGE_RESOLUTION })
}

/** 把当前参数复制为可以直接传给 `setGlassDefaults()` 的 JSON。 */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(defaults.value, null, 2))
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1600)
  }
  catch {}
}

/** 在点击时切换面板；拖动产生的 click 不触发展开。 */
function toggle(event: MouseEvent): void {
  if (suppressClick && event.detail !== 0) {
    suppressClick = false
    return
  }
  suppressClick = false
  opened.value = !opened.value
}

/** 收起面板，并在键盘关闭时将焦点交回入口。 */
function close(restoreFocus = true): void {
  opened.value = false
  if (restoreFocus)
    launcher.value?.focus({ preventScroll: true })
}

/** 记录拖动起点，指针移出按钮后也能完成拖动。 */
function startDrag(event: PointerEvent): void {
  if (event.button !== 0 || gesture)
    return
  gesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: position.value.x,
    top: position.value.y,
  }
  suppressClick = false
  launcher.value?.setPointerCapture(event.pointerId)
}

/** 超过六像素后按拖动处理，并把按钮限制在可见范围。 */
function moveDrag(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId)
    return
  const dx = event.clientX - gesture.startX
  const dy = event.clientY - gesture.startY
  if (!dragging.value && Math.hypot(dx, dy) < 6)
    return
  dragging.value = true
  suppressClick = true
  position.value = clampLauncherPosition({ x: gesture.left + dx, y: gesture.top + dy }, viewport.value, buttonSize.value)
}

/** 结束拖动；指针取消时也清理按下状态。 */
function endDrag(event: PointerEvent): void {
  if (gesture?.pointerId !== event.pointerId)
    return
  gesture = null
  dragging.value = false
  if (launcher.value?.hasPointerCapture(event.pointerId))
    launcher.value.releasePointerCapture(event.pointerId)
}

/** 使用方向键移动入口，按住 Shift 时增加移动距离。 */
function moveWithKeyboard(event: KeyboardEvent): void {
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const offset = offsets[event.key]
  if (!offset)
    return
  event.preventDefault()
  const step = event.shiftKey ? 40 : 16
  position.value = clampLauncherPosition({ x: position.value.x + offset[0] * step, y: position.value.y + offset[1] * step }, viewport.value, buttonSize.value)
}

/** 调整窗口后将入口移回可见区域。 */
function resize(): void {
  viewport.value = { x: window.innerWidth, y: window.innerHeight }
  position.value = clampLauncherPosition(position.value, viewport.value, buttonSize.value)
}

/** 面板打开期间定时读取实际倍率，自适应调整玻璃着色倍率后能及时显示。 */
function watchPixelRatio(active: boolean): void {
  clearInterval(ratioTimer)
  ratioTimer = undefined
  if (!active || !renderer)
    return
  const read = (): void => {
    const metrics = renderer.metrics()
    ratios.value = metrics && { canvas: metrics.dpr, glass: metrics.glassDpr }
  }
  read()
  ratioTimer = setInterval(read, 500)
}

watch(opened, watchPixelRatio)
watch(() => props.disabled, (disabled) => {
  if (disabled)
    close(false)
})
onMounted(() => {
  resize()
  window.addEventListener('resize', resize, { passive: true })
})
onBeforeUnmount(() => {
  clearTimeout(copyTimer)
  clearInterval(ratioTimer)
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <div v-show="!disabled" class="tuner-root" @keydown.esc.stop.prevent="close()">
    <div v-if="visible" class="tuner-panel-anchor" :style="panelStyle">
      <section
        data-liquid-glass
        :data-glass-layer="PANEL_LAYER"
        data-glass-radius="28"
        data-glass-fusion="40"
        data-glass-variant="regular"
        :data-glass-blur="1 + Math.min(1, progress) * 27"
        data-glass-refraction="20"
        :data-glass-tint="theme === 'dark' ? '#10191a' : '#f5f5ef'"
        :data-glass-tint-alpha="0.04 + Math.min(1, progress) * (theme === 'dark' ? 0.64 : 0.62)"
        class="tuner-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tuner-title"
        :aria-hidden="!ready"
        :inert="!ready"
      >
        <div class="tuner-content" :style="{ opacity: ready ? 1 : 0 }">
          <header class="tuner-heading">
            <div>
              <h2 id="tuner-title">
                {{ tr('玻璃调参', 'Glass tuning') }}
              </h2>
              <p>{{ tr('全局默认参数 · 实时生效', 'Global defaults · applied live') }}</p>
            </div>
            <button type="button" class="tuner-close" :aria-label="tr('关闭调参面板', 'Close tuning panel')" @click="close()">
              <AppIcon name="close" :size="18" />
            </button>
          </header>

          <div class="tuner-body">
            <section v-if="renderer" class="tuner-section" data-section="renderer">
              <h3>{{ tr('渲染方式', 'Renderer') }}</h3>
              <div class="tuner-segment" role="group" :aria-label="tr('渲染方式', 'Renderer')">
                <button
                  v-for="option in MODES"
                  :key="option.id"
                  type="button"
                  :data-mode="option.id"
                  :aria-pressed="renderer.mode.value === option.id"
                  :disabled="renderer.switching.value || (option.id === 'canvas' && !renderer.canvasSupported) || (option.id === 'svg' && !renderer.svgSupported)"
                  @click="renderer.setMode(option.id)"
                >
                  {{ tr(option.zh, option.en) }}
                </button>
              </div>
              <p v-if="renderer.error.value" class="tuner-hint is-error">
                {{ tr('画布启动失败，已改用回退实现：', 'The canvas failed to start; using the fallback: ') }}{{ renderer.error.value }}
              </p>
              <p v-else-if="renderer.mode.value === 'svg'" class="tuner-hint">
                {{ tr('SVG 滤镜回退：backdrop-filter 加位移贴图，有边缘折射与色散；透镜放大、融合、抬升和内容遮挡不起作用。', 'SVG filter fallback: backdrop-filter with a displacement map gives edge refraction and dispersion. Magnification, fusion, elevation and content occlusion have no effect.') }}
              </p>
              <p v-else-if="renderer.mode.value === 'css'" class="tuner-hint">
                {{ tr('纯 CSS 回退只有模糊、染色、阴影和轮廓高光，厚度、色散、透镜放大、融合不起作用。', 'The CSS-only fallback has blur, tint, shadow and an edge highlight. Thickness, dispersion, magnification and fusion have no effect.') }}
              </p>
              <p v-if="!renderer.canvasSupported" class="tuner-hint">
                {{ tr('这个浏览器缺少 HTML-in-Canvas 或 WebGPU，不能使用画布渲染。', 'This browser lacks HTML-in-Canvas or WebGPU, so canvas rendering is unavailable.') }}
              </p>
              <template v-if="canvasActive">
                <label class="tuner-field">
                  <span>{{ tr('画布倍率上限（文字）', 'Max canvas ratio (text)') }}</span>
                  <output>{{ renderer.resolution.value.maxPixelRatio.toFixed(2) }}×</output>
                  <input
                    type="range" min="1" max="3" step="0.25" data-field="maxPixelRatio"
                    :value="renderer.resolution.value.maxPixelRatio"
                    @input="renderer.setResolution({ maxPixelRatio: inputNumber($event) })"
                  >
                </label>
                <label class="tuner-field">
                  <span>{{ tr('玻璃着色倍率上限', 'Max glass shading ratio') }}</span>
                  <output>{{ renderer.resolution.value.maxGlassPixelRatio.toFixed(2) }}×</output>
                  <input
                    type="range" min="0.5" max="3" step="0.25" data-field="maxGlassPixelRatio"
                    :value="renderer.resolution.value.maxGlassPixelRatio"
                    @input="renderer.setResolution({ maxGlassPixelRatio: inputNumber($event) })"
                  >
                </label>
                <label class="tuner-check">
                  <input
                    type="checkbox"
                    :checked="renderer.resolution.value.adaptive"
                    @change="renderer.setResolution({ adaptive: ($event.target as HTMLInputElement).checked })"
                  >
                  <span>{{ tr('帧率不足时自动降低玻璃着色倍率', 'Lower the glass shading ratio when frames drop') }}</span>
                </label>
                <p v-if="ratios" class="tuner-hint" data-role="ratios">
                  {{ tr('当前画布', 'Canvas now') }} {{ ratios.canvas.toFixed(2) }}× · {{ tr('玻璃着色', 'glass shading') }} {{ ratios.glass.toFixed(2) }}×
                </p>
              </template>
            </section>

            <section class="tuner-section" data-section="material">
              <h3>{{ tr('材质', 'Material') }} · {{ theme === 'dark' ? tr('深色主题', 'dark theme') : tr('浅色主题', 'light theme') }}</h3>
              <div class="tuner-segment" role="group" :aria-label="tr('材质', 'Material')">
                <button
                  v-for="option in VARIANTS"
                  :key="option.id"
                  type="button"
                  :data-variant="option.id"
                  :aria-pressed="variant === option.id"
                  @click="variant = option.id"
                >
                  {{ tr(option.zh, option.en) }}
                </button>
              </div>
              <label v-for="field in MATERIAL_FIELDS" :key="field.key" class="tuner-field">
                <span>{{ tr(field.zh, field.en) }}</span>
                <output>{{ format(material[field.key], field) }}</output>
                <input
                  type="range"
                  :data-field="field.key"
                  :min="GLASS_LIMITS[field.key][0]"
                  :max="field.max ?? GLASS_LIMITS[field.key][1]"
                  :step="field.step"
                  :value="material[field.key]"
                  @input="setMaterial(field.key, inputNumber($event))"
                >
              </label>
              <label class="tuner-field is-color">
                <span>{{ tr('染色', 'Tint color') }}</span>
                <output>{{ material.tint }}</output>
                <input
                  type="color"
                  data-field="tint"
                  :value="material.tint"
                  @input="setMaterial('tint', ($event.target as HTMLInputElement).value)"
                >
              </label>
            </section>

            <section class="tuner-section" data-section="shape">
              <h3>{{ tr('形体', 'Shape') }}</h3>
              <label v-for="field in SHAPE_FIELDS" :key="field.key" class="tuner-field">
                <span>{{ tr(field.zh, field.en) }}</span>
                <output>{{ format(defaults[field.key], field) }}</output>
                <input
                  type="range"
                  :data-field="field.key"
                  :min="GLASS_LIMITS[field.key][0]"
                  :max="field.max ?? GLASS_LIMITS[field.key][1]"
                  :step="field.step"
                  :value="defaults[field.key]"
                  @input="setShape(field.key, inputNumber($event))"
                >
              </label>
            </section>
          </div>

          <footer class="tuner-footer">
            <button type="button" data-action="reset" @click="reset">
              {{ tr('恢复默认', 'Reset') }}
            </button>
            <button type="button" data-action="copy" @click="copy">
              {{ copied ? tr('已复制', 'Copied') : tr('复制参数', 'Copy JSON') }}
            </button>
          </footer>
          <p class="tuner-note">
            {{ tr('只影响没有用 data-glass-* 单独声明的属性。拖动圆形按钮可以移动面板。', 'Only affects properties without their own data-glass-* attribute. Drag the round button to move the panel.') }}
          </p>
        </div>
      </section>
    </div>
    <div class="tuner-launcher-anchor" :style="{ left: `${position.x}px`, top: `${position.y}px`, width: `${buttonSize}px`, height: `${buttonSize}px` }">
      <button
        ref="launcher"
        type="button"
        data-liquid-glass
        :data-glass-layer="visible ? PANEL_LAYER : 0"
        data-glass-radius="999"
        data-glass-fusion="40"
        data-glass-variant="clear"
        class="tuner-launcher"
        :class="{ 'is-dragging': dragging }"
        :aria-label="tr('玻璃调参', 'Glass tuning')"
        :aria-expanded="opened"
        :title="tr('拖动移动，点击调参；方向键也可以移动', 'Drag to move, click to tune; arrow keys also move')"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @lostpointercapture="endDrag"
        @keydown="moveWithKeyboard"
        @click="toggle"
      >
        <AppIcon :name="opened ? 'close' : 'adjust'" :size="25" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tuner-root { position: fixed; inset: 0; z-index: 44; pointer-events: none; }
.tuner-launcher-anchor, .tuner-panel-anchor { position: absolute; }
.tuner-launcher { position: absolute; inset: 0; width: 100%; height: 100%; display: grid; place-items: center; border-radius: 50%; pointer-events: auto; touch-action: none; user-select: none; cursor: grab; color: var(--text); }
.tuner-launcher.is-dragging { cursor: grabbing; }
.tuner-panel { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 28px; overflow: clip; pointer-events: auto; color: var(--text); }
.tuner-content { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tuner-heading { display: flex; justify-content: space-between; align-items: center; padding: 20px 20px 15px; border-bottom: 1px solid var(--line); }
.tuner-heading h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.03em; }
.tuner-heading p { margin-top: 5px; font-size: 10px; color: var(--text-soft); }
.tuner-close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; cursor: pointer; }
.tuner-close:hover { background: var(--hover); }
.tuner-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 20px 8px; }
.tuner-section { padding: 14px 0 12px; border-bottom: 1px solid var(--line); }
.tuner-section:last-child { border-bottom: 0; }
.tuner-section h3 { font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-soft); }
.tuner-segment { display: flex; gap: 4px; margin-top: 10px; padding: 4px; border-radius: 14px; background: var(--hover); border: 1px solid var(--line); }
.tuner-segment button { flex: 1; height: 32px; border-radius: 10px; font-size: 12px; font-weight: 550; cursor: pointer; }
.tuner-segment button[aria-pressed='true'] { background: var(--text); color: var(--bg); }
.tuner-segment button:disabled { opacity: 0.4; cursor: default; }
.tuner-field { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 2px 10px; margin-top: 11px; font-size: 12px; }
.tuner-field output { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-soft); }
.tuner-field input[type='range'] { grid-column: 1 / -1; width: 100%; height: 18px; accent-color: var(--text); cursor: pointer; }
.tuner-field.is-color { grid-template-columns: 1fr auto auto; align-items: center; }
.tuner-field input[type='color'] { width: 34px; height: 24px; padding: 0; border: 1px solid var(--line); border-radius: 7px; background: transparent; cursor: pointer; }
.tuner-check { display: flex; align-items: center; gap: 8px; margin-top: 11px; font-size: 12px; cursor: pointer; }
.tuner-check input { width: 15px; height: 15px; accent-color: var(--text); }
.tuner-hint { margin-top: 9px; font-size: 10px; line-height: 1.6; color: var(--text-soft); }
.tuner-hint.is-error { color: #e0786c; overflow-wrap: anywhere; }
.tuner-footer { display: flex; gap: 8px; padding: 12px 20px 0; border-top: 1px solid var(--line); }
.tuner-footer button { flex: 1; height: 36px; border: 1px solid var(--line); border-radius: 18px; font-size: 12px; font-weight: 550; cursor: pointer; }
.tuner-footer button:hover { background: var(--hover); }
.tuner-note { margin: 10px 20px 14px; font-size: 9px; line-height: 1.5; text-align: center; color: var(--text-soft); }
</style>
