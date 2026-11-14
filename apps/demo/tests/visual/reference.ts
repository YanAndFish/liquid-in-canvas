import type { GlassVariant, StageResolution } from 'liquid-in-canvas'
import { getGlassDefaults } from 'liquid-in-canvas'
import { CanvasStage } from 'liquid-in-canvas/canvas'
import { applyGlassQuery } from '../query'

/**
 * 与 Apple 官方画面对照的几何条件。背景全部用 CSS 画或使用演示已有的图片。
 *
 * 查询参数：
 * - `scene`：capsule / toolbar / disc / buttons。
 * - `variant`：clear / regular，缺省取场景自己的材质。
 * - `blur`、`refraction`、`bevelWidth`、`bevelHeight`、`bevelCurve`、`lens`、`dispersion`、`elevation`、`fusion`：
 *   覆盖全局默认参数，未给出时使用场景的设定或库的默认值。三颗按钮的场景默认关闭融合，与参考画面一致。
 * - `split`：分界线相对玻璃中心的偏移，以玻璃短边为单位（胶囊向下为正，圆形向右下为正）。
 * - `panel=0`：隐藏参数面板，截图时使用。
 * - `adaptive`、`maxPixelRatio`、`maxGlassPixelRatio`：与测量页相同，固定渲染倍率。
 *
 * 当前场景的玻璃轮廓与分界线写在 `window.reference`，截图脚本据此调用 `profile_fit.py`。
 */

type SceneName = 'capsule' | 'toolbar' | 'disc' | 'buttons'

interface Outline {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

interface ReferenceState {
  scene: SceneName
  /** 当前场景所有玻璃的轮廓，CSS 像素。 */
  outlines: Outline[]
  /** 两色分界线经过的一点与方向角（度，0 为水平向右，顺时针为正），没有分界线的场景为 null。 */
  boundary: { x: number, y: number, angle: number } | null
  /** 画布已经启动并绘制过。 */
  ready: boolean
}

declare global {
  interface Window {
    reference?: ReferenceState
  }
}

type ParamKey = 'blur' | 'refraction' | 'bevelWidth' | 'bevelHeight' | 'bevelCurve' | 'lens' | 'dispersion' | 'elevation' | 'fusion'

interface SceneSetup {
  variant: GlassVariant
  split: number
  /** 场景自己的参数，优先于库的默认值、低于查询参数。 */
  params?: Partial<Record<ParamKey, number>>
}

const SCENES: Record<SceneName, SceneSetup> = {
  capsule: { variant: 'clear', split: -0.2 },
  toolbar: { variant: 'regular', split: 0 },
  disc: { variant: 'clear', split: 0.2 },
  buttons: {
    variant: 'regular',
    split: 0,
    params: { fusion: 0 },
  },
}

interface Param {
  key: ParamKey
  label: string
  attr: string
  min: number
  max: number
  step: number
}

const PARAMS: Param[] = [
  {
    key: 'blur',
    label: '模糊',
    attr: 'data-glass-blur',
    min: 0,
    max: 80,
    step: 0.5,
  },
  {
    key: 'refraction',
    label: '厚度 refraction',
    attr: 'data-glass-refraction',
    min: 0,
    max: 80,
    step: 0.5,
  },
  {
    key: 'bevelWidth',
    label: '倒角宽',
    attr: 'data-glass-bevel-width',
    min: 0.1,
    max: 4,
    step: 0.01,
  },
  {
    key: 'bevelHeight',
    label: '倒角高',
    attr: 'data-glass-bevel-height',
    min: 0.05,
    max: 1,
    step: 0.01,
  },
  {
    key: 'bevelCurve',
    label: '曲线指数',
    attr: 'data-glass-bevel-curve',
    min: 1,
    max: 8,
    step: 0.1,
  },
  {
    key: 'lens',
    label: '透镜',
    attr: 'data-glass-lens',
    min: 0,
    max: 0.6,
    step: 0.01,
  },
  {
    key: 'dispersion',
    label: '色散',
    attr: 'data-glass-dispersion',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'elevation',
    label: '底面高度',
    attr: 'data-glass-elevation',
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: 'fusion',
    label: '融合距离',
    attr: 'data-glass-fusion',
    min: 0,
    max: 100,
    step: 1,
  },
]

const query = new URLSearchParams(location.search)
applyGlassQuery(query)

function element<T extends HTMLElement>(selector: string, parent: ParentNode = document): T {
  const found = parent.querySelector<T>(selector)
  if (!found)
    throw new Error(`缺少元素 ${selector}`)
  return found
}

function isScene(value: string | null): value is SceneName {
  return value !== null && value in SCENES
}

const sceneSelect = element<HTMLSelectElement>('#scene')
const variantSelect = element<HTMLSelectElement>('#variant')
const sliders = element<HTMLDivElement>('#sliders')
const panel = element<HTMLFormElement>('#panel')
const outlineText = element<HTMLElement>('#outline')
const boundaryText = element<HTMLElement>('#boundary')

let scene: SceneName = isScene(query.get('scene'))
  ? query.get('scene') as SceneName
  : 'capsule'
const state: ReferenceState = {
  scene,
  outlines: [],
  boundary: null,
  ready: false,
}
window.reference = state

function variant(): GlassVariant {
  const raw = query.get('variant')
  return raw === 'clear' || raw === 'regular'
    ? raw
    : SCENES[scene].variant
}

function split(): number {
  const raw = Number.parseFloat(query.get('split') ?? '')
  return Number.isFinite(raw)
    ? raw
    : SCENES[scene].split
}

function defaultValue(param: Param): number {
  const defaults = getGlassDefaults()
  if (param.key === 'elevation' || param.key === 'fusion')
    return defaults[param.key]
  return defaults.materials[variant()].light[param.key]
}

function override(param: Param): number | null {
  const raw = Number.parseFloat(query.get(param.key) ?? '')
  return Number.isFinite(raw)
    ? raw
    : SCENES[scene].params?.[param.key] ?? null
}

const inputs = new Map<Param['key'], { input: HTMLInputElement, output: HTMLOutputElement }>()
for (const param of PARAMS) {
  const label = document.createElement('label')
  const output = document.createElement('output')
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(param.min)
  input.max = String(param.max)
  input.step = String(param.step)
  label.append(param.label, output, input)
  sliders.append(label)
  inputs.set(param.key, { input, output })
  input.addEventListener('input', () => {
    query.set(param.key, input.value)
    update()
  })
}

const splitLabel = document.createElement('label')
const splitOutput = document.createElement('output')
const splitInput = document.createElement('input')
splitInput.type = 'range'
splitInput.min = '-0.45'
splitInput.max = '0.45'
splitInput.step = '0.01'
splitLabel.append('分界线偏移（短边）', splitOutput, splitInput)
sliders.append(splitLabel)
splitInput.addEventListener('input', () => {
  query.set('split', splitInput.value)
  update()
})

sceneSelect.addEventListener('input', () => {
  scene = sceneSelect.value as SceneName
  query.set('scene', scene)
  query.delete('variant')
  query.delete('split')
  update()
})
variantSelect.addEventListener('input', () => {
  query.set('variant', variantSelect.value)
  update()
})
element<HTMLButtonElement>('#reset').addEventListener('click', () => {
  for (const param of PARAMS)
    query.delete(param.key)
  query.delete('split')
  update()
})
if (query.get('panel') === '0')
  panel.hidden = true
window.addEventListener('keydown', (event) => {
  if (event.key === 'h' || event.key === 'H')
    panel.hidden = !panel.hidden
})

function place(target: HTMLElement, outline: Outline): void {
  target.style.left = `${outline.x}px`
  target.style.top = `${outline.y}px`
  target.style.width = `${outline.width}px`
  target.style.height = `${outline.height}px`
  target.style.borderRadius = `${outline.radius}px`
  target.dataset.glassRadius = String(outline.radius)
}

function centered(cx: number, cy: number, width: number, height: number, radius: number): Outline {
  return {
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width,
    height,
    radius,
  }
}

/** 按视口计算当前场景的几何；截图在固定视口下进行，因此结果可复现。 */
function layout(root: HTMLElement): void {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cx = vw / 2
  const cy = vh / 2
  const glasses = [
    ...root.querySelectorAll<HTMLElement>('[data-reference-glass]'),
  ]
  const offset = split()
  state.outlines = []
  state.boundary = null

  if (scene === 'capsule') {
    const height = Math.round(Math.min(240, vw * 0.22, vh * 0.3))
    const outline = centered(cx, cy, height * 2, height, height / 2)
    const y = Math.round(outline.y + height / 2 + offset * height)
    element<HTMLElement>('.dark', root).style.top = `${y}px`
    state.outlines.push(outline)
    state.boundary = { x: cx, y, angle: 0 }
  }
  else if (scene === 'toolbar') {
    state.outlines.push(centered(cx, cy, Math.round(Math.min(360, vw * 0.8)), 64, 32))
  }
  else if (scene === 'disc') {
    const size = Math.round(Math.min(260, vw * 0.35, vh * 0.4))
    const outline = centered(cx, cy, size, size, size / 2)
    const along = offset * size / Math.SQRT2
    const x = Math.round(outline.x + size / 2 + along)
    const y = Math.round(outline.y + size / 2 + along)
    const dark = element<HTMLElement>('.dark', root)
    dark.style.left = `${x - 3000}px`
    dark.style.top = `${y}px`
    state.outlines.push(outline)
    state.boundary = { x, y, angle: -45 }
  }
  else {
    const sizes = [72, 96, 72]
    const gap = 28
    const total = sizes.reduce((sum, size) => sum + size, 0) + gap * (sizes.length - 1)
    let left = cx - total / 2
    for (const size of sizes) {
      state.outlines.push(centered(left + size / 2, vh * 0.62, size, size, size / 2))
      left += size + gap
    }
  }

  glasses.forEach((glass, index) => {
    const outline = state.outlines[index]
    if (outline)
      place(glass, outline)
  })
}

/** 把查询参数应用到页面：场景可见性、玻璃属性、面板状态与地址栏。 */
function update(): void {
  const root = element<HTMLElement>(`#${scene}`)
  for (const name of Object.keys(SCENES))
    element<HTMLElement>(`#${name}`).hidden = name !== scene
  state.scene = scene
  layout(root)

  const material = variant()
  for (const glass of root.querySelectorAll<HTMLElement>('[data-reference-glass]')) {
    glass.dataset.glassVariant = material
    for (const param of PARAMS) {
      const value = override(param)
      if (value === null)
        glass.removeAttribute(param.attr)
      else
        glass.setAttribute(param.attr, String(value))
    }
  }

  sceneSelect.value = scene
  variantSelect.value = material
  for (const param of PARAMS) {
    const control = inputs.get(param.key)
    if (!control)
      continue
    const value = override(param)
    control.input.value = String(value ?? defaultValue(param))
    control.output.value = value === null
      ? `默认 ${defaultValue(param)}`
      : String(value)
    control.output.classList.toggle('set', value !== null)
  }
  splitLabel.hidden = state.boundary === null
  splitInput.value = String(split())
  splitOutput.value = split().toFixed(2)

  outlineText.textContent = state.outlines
    .map(o => `${o.x},${o.y},${o.width},${o.height} r${o.radius}`)
    .join('\n')
  boundaryText.textContent = state.boundary
    ? `过 (${state.boundary.x}, ${state.boundary.y})，角度 ${state.boundary.angle}°`
    : '无'

  history.replaceState(null, '', `${location.pathname}?${query.toString()}`)
}

update()
window.addEventListener('resize', update)

const resolution: Partial<StageResolution> = {}
if (query.has('maxPixelRatio'))
  resolution.maxPixelRatio = Number(query.get('maxPixelRatio'))
if (query.has('maxGlassPixelRatio'))
  resolution.maxGlassPixelRatio = Number(query.get('maxGlassPixelRatio'))
if (query.has('adaptive'))
  resolution.adaptive = query.get('adaptive') !== '0'

async function start(): Promise<void> {
  const canvas = element<HTMLCanvasElement>('#stage')
  const stage = new CanvasStage({
    canvas,
    onFault: console.error,
    resolution,
    theme: 'light',
  })
  await stage.init()
  stage.start(element<HTMLElement>('#app'))
  requestAnimationFrame(() => requestAnimationFrame(() => {
    state.ready = true
  }))
  window.addEventListener('pagehide', () => stage.dispose(), { once: true })
}

start().catch(console.error)
