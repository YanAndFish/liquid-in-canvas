# liquid-in-canvas

用 **HTML-in-Canvas + WebGPU** 给实时 HTML 加上液态玻璃：折射、凸透镜放大、色散、同层融合、内容遮挡、按压形变和液体迁移。页面和控件仍然是可点击、可聚焦的普通 HTML，只需要在元素上加属性。

浏览器不支持时自动回退，读取同一套属性：Chromium 内核用 `backdrop-filter` 加 SVG 位移滤镜保留边缘折射、色散和轮廓高光，其他浏览器用纯 `backdrop-filter`。

## 安装

```sh
pnpm add liquid-in-canvas
```

没有运行时依赖。画布渲染器直接使用 WebGPU，在确认浏览器支持后才动态加载（演示商店的生产构建里压缩后约 66 kB，gzip 约 23 kB），只能使用回退实现的浏览器不会下载它。完整效果需要支持 HTML-in-Canvas、WebGPU 和 `GPUQueue.drawElementImageToTexture()` 的浏览器（开发时使用 Chrome 157）。

## 使用

```html
<div id="app">
  <div style="position: relative">
    <button data-liquid-glass data-glass-radius="999">浏览系列</button>
  </div>
</div>
```

```ts
import { mountLiquidGlass } from 'liquid-in-canvas'

const glass = await mountLiquidGlass({
  root: document.querySelector('#app')!,
  canvasClass: 'stage',
})

console.log(glass.mode) // 'canvas'、'svg' 或 'css'
```

画布模式下，`mountLiquidGlass` 会创建一张 `<canvas content="drawable">` 插入到根元素原来的位置，并把根元素移入画布。画布的尺寸由你的样式决定，通常铺满视口：

```css
.stage { position: fixed; inset: 0; width: 100dvw; height: 100dvh; display: block; }
#app[drawable] { width: 100dvw; height: 100dvh; overflow: clip; }
```

根元素成为画布子元素后，页面滚动需要发生在根元素内部的滚动容器里，而不是 `window`。

### 渲染方式

| `mode` | 行为 |
| --- | --- |
| `'auto'`（缺省） | 按 `canvas` → `svg` → `css` 的顺序使用浏览器支持的第一种。画布不支持、初始化失败或运行中出错时改用回退，并调用 `onFault` 说明原因 |
| `'canvas'` | 只用画布。不支持时抛出 `StageUnsupportedError`，初始化失败抛出原始错误；运行中出错调用 `onFault`，由你决定后续处理 |
| `'svg'` | `backdrop-filter` 加 SVG 位移滤镜。浏览器不支持时使用 `'css'`，以返回值的 `mode` 为准 |
| `'css'` | 只用 `backdrop-filter` |

两种回退都不改变页面结构。

| 回退 | 效果 | 浏览器 |
| --- | --- | --- |
| `svg` | 模糊、染色、圆角、阴影，加上边缘折射、色散和按光照方向分布的轮廓高光 | Chromium 内核，可用 `supportsSvgBackdropFilter()` 检测 |
| `css` | 模糊、染色、圆角、阴影和一圈轮廓高光 | 支持 `backdrop-filter` 的浏览器 |

回退没有同层融合、内容遮挡和按压形变。`svg` 方式下，面积超过 12 万 CSS 像素的玻璃（大面板）只用模糊：滤镜开销与面积成正比，背景每变化一帧都要重算。清晰背景（`data-glass-blur="0"`）上的折射比画布粗糙，位移滤镜按整像素取样。

```ts
const glass = await mountLiquidGlass({
  root,
  mode: 'auto',
  onFault(fault) {
    // fault.kind: 'unsupported' | 'init' | 'runtime'
    console.warn('已改用回退实现', fault)
  },
})

glass.dispose() // 停止渲染，页面恢复到挂载前的状态
```

要在运行中切换方式，先 `dispose()` 再用另一个 `mode` 重新挂载。根元素在文档中移动时，内部的滚动位置会归零，正在播放的视频会被暂停，需要自行恢复。

使用框架时，在 `beforeStart` 里挂载应用。此时根元素已经在最终位置，舞台还没有开始绘制：

```ts
await mountLiquidGlass({
  root,
  beforeStart: () => app.mount(root),
})
```

也可以用 `detectStageSupport()` 先行检测，再决定显示什么。

## 元素属性

在元素上添加 `data-liquid-glass`。它的定位父元素应当是没有 `drawable` 属性的普通元素，自身背景应当透明。

| 属性 | 含义 | 缺省 |
| --- | --- | --- |
| `data-glass-variant` | `regular` 或 `clear`，决定下面各项的默认值 | `regular` |
| `data-glass-radius` | 圆角，支持 CSS 顺序的一至四个值 | 28 |
| `data-glass-blur` | 背景高斯模糊的标准差，0–80 | 18 / 8 |
| `data-glass-refraction` | 三维实体的半厚度参考值，0–80，实际厚度受控件短边限制 | 24 / 20 |
| `data-glass-dispersion` | RGB 采样分离强度，0–1 | 0.3 / 0.4 |
| `data-glass-lens` | 凸透镜强度，0–0.6。玻璃中间的背景放大约 1 / (1 − lens) 倍，长条形只沿短边放大 | 0.14 / 0.22 |
| `data-glass-tint` | 十六进制染色值 | 随主题 |
| `data-glass-tint-alpha` | 染色比例，0–1 | 随主题 |
| `data-glass-specular` | 轮廓高光强度，0–2 | 0.7 / 0.9 |
| `data-glass-shadow` | 外侧阴影强度，0–1 | 0.32 / 0.26 |
| `data-glass-shadow-size` | 阴影范围，0–100 | 32 / 28 |
| `data-glass-layer` | 玻璃层级，值越大越靠前，只有同层玻璃会融合 | 0 |
| `data-glass-fusion` | 融合距离，0 表示关闭 | 32 |
| `data-glass-elevation` | 玻璃底面到背景的距离 | 16 |
| `data-glass-anchor` | 用于定位的祖先选择器 | `offsetParent` |
| `data-glass-morph` | 液体迁移，见下文。空值表示自身位置或尺寸变化时流动过去，非空值同时是迁移的名字 | 关闭 |

长度单位都是 CSS 像素，缺省一栏写作 `regular / clear`。`data-glass-lens` 与后五项只对画布渲染有效；折射、透镜和色散在 `css` 回退下不起作用。

辅助属性（画布渲染）：

- `data-glass-clip`：加在普通祖先上，后代玻璃和阴影限制在它的矩形内。
- `data-glass-modal` 与 `data-glass-scrim`：模态层根节点和其中的遮罩。打开时模态层外的玻璃按遮罩透明度压暗。
- `data-glass-fade`：页面切换容器，其 `opacity` 作用到内部玻璃。
- `data-stage-overlay`：单独上传的透明前景层，用于需要插在玻璃之间的内容（例如跨越多块玻璃的过渡动画）。属性值是一个玻璃层级：`data-stage-overlay="5"` 盖住低于第 5 层的玻璃，被第 5 层及更高层的玻璃盖住；不写值时位于所有玻璃之上。需要在开始绘制前存在，一个页面一个。

## 嵌套玻璃与液体迁移

玻璃里可以再放一层玻璃，例如标签组里的激活项：

```html
<div data-liquid-glass data-glass-radius="999" role="group">
  <button data-liquid-glass data-glass-morph="tabs" data-glass-variant="clear" aria-pressed="true">全部</button>
  <button aria-pressed="false">家居</button>
  <button aria-pressed="false">厨房</button>
</div>
```

- 嵌套玻璃只有体积：它的 HTML 已经包含在外层玻璃的快照里，文字由外层清晰地画在它上面。它画在外层体积之上，与外层同层，不与外层融合，只与同一外层里的其他嵌套玻璃融合。只支持一层嵌套。
- 嵌套玻璃折射的是页面背景，不是外层玻璃本身（不同玻璃之间没有递归折射），所以它看起来像嵌在磨砂外层里的一块通透玻璃。
- 切换激活项时，把 `data-liquid-glass` 连同同名的 `data-glass-morph` 从旧按钮移到新按钮（框架里按激活状态绑定属性即可）。画布渲染下，玻璃体积从旧位置流向新位置：朝运动方向的一端先到并略微越过目标，另一端被拖在后面，体积先被拉长变细再收拢。
- 同一个元素的 `data-glass-morph` 为空值时，它自己的位置或尺寸变化（不含滚动和窗口缩放）也以同样的方式过渡。
- 系统要求减少动态效果时直接到位；回退实现里激活项是一块直接切换的高亮。

## 全局默认参数

没有在元素上声明的属性取全局默认值，可以随时修改，已挂载的页面在下一帧应用：

```ts
import { getGlassDefaults, onGlassDefaultsChange, resetGlassDefaults, setGlassDefaults } from 'liquid-in-canvas'

setGlassDefaults({
  fusion: 40,
  materials: {
    regular: {
      dark: { blur: 24, tintAlpha: 0.36 },
      light: { blur: 24 },
    },
  },
})

getGlassDefaults().materials.regular.dark.blur // 24
const stop = onGlassDefaultsChange(defaults => console.log(defaults))
resetGlassDefaults()
```

补丁里没有列出的字段保持不变。数值会被限制在 `GLASS_LIMITS` 内，无效值被忽略；`getGlassDefaults()` 返回的对象是冻结的。库内置的值是 `BUILTIN_GLASS_DEFAULTS`。

材质按主题分为 `light` 和 `dark`。主题的来源依次是：挂载时的 `theme` 选项或 `glass.setTheme()` → `<html data-theme="light|dark">` → 系统配色。

## 分辨率与性能

画布分辨率和玻璃着色分辨率分开控制。页面文字画在画布上，画布倍率低于设备倍率时文字会变软；玻璃后的背景本来就经过折射和模糊，单独降低它的着色分辨率几乎看不出来。

```ts
await mountLiquidGlass({
  root,
  resolution: {
    maxPixelRatio: 3, // 画布倍率上限，决定文字清晰度，缺省 3
    maxPixels: Infinity, // 画布像素总数上限，缺省不限
    maxGlassPixelRatio: 2, // 玻璃着色倍率上限，缺省 2
    adaptive: true, // 持续掉帧时自动降低玻璃着色倍率，流畅后升回，缺省开启
  },
})

glass.stage?.setResolution({ maxGlassPixelRatio: 1.5 })
glass.stage?.getMetrics() // { dpr: 画布实际倍率, glassDpr: 玻璃实际着色倍率, … }
```

- `adaptive` 只调整玻璃着色倍率（每级 ×0.75，最低到一半），不改变画布尺寸，文字不会因此变糊。
- 整页快照、页面绘制和模糊的开销与画布像素数成正比，不受玻璃着色倍率影响。画布很大时（例如 5K 屏幕上的全屏窗口）要靠 `maxPixelRatio` 或 `maxPixels` 降低画布分辨率，这是用文字清晰度换帧率，由你决定。画布倍率不会低于 1。
- 同层玻璃靠近或重叠时会并入同一个融合组，组内每个像素都要对所有成员求距离。大面积的面板请用 `data-glass-layer` 放到单独的层，避免和它下方的控件融合。

## 其他导出

- `liquid-in-canvas/canvas`：`CanvasStage`，画布渲染器本身。需要自己管理画布时使用；`mountLiquidGlass` 在需要时动态加载它。
- `CssGlassStage`：回退实现本身，`refraction` 选项控制是否使用 SVG 滤镜。
- `liquid-in-canvas/motion`：`advanceSpring`、`reducedMotionQuery`、`prefersReducedMotion`。玻璃按压使用的阻尼弹簧，页面自己的动画用同一套参数时手感一致。这个入口不引入画布渲染器。

## 范围

这是对 Apple Liquid Glass 视觉行为的 Web 近似，不是原生材质。同层融合用三维平滑距离场近似表面张力；背景语义适配、设备姿态光照和不同玻璃层间的递归折射没有实现。设计说明见仓库的 `docs/`。
