# liquid-in-canvas

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

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
| `data-glass-blur` | 背景高斯模糊的标准差，0–80 | 18 / 0 |
| `data-glass-refraction` | 三维实体的半厚度上限，0–80。实际厚度为短边的 0.3 倍，不超过这个值 | 80 |
| `data-glass-bevel-width` | 边缘倒角的水平宽度，按半厚度的倍数，0.1–4，不超过短边的一半 | 0.8 |
| `data-glass-bevel-height` | 边缘倒角的垂直高度，按半厚度的倍数，0.05–1；1 表示侧面没有竖直部分 | 1 |
| `data-glass-bevel-curve` | 倒角曲线的超椭圆指数，1–8：1 是直线斜面，2 是椭圆弧，越大越接近直角 | 2.75 |
| `data-glass-bottom-bevel` | 底面倒角相对顶面倒角的比例，0–1；0 表示底面是带直角边的平面 | 1 |
| `data-glass-dispersion` | RGB 采样分离强度，0–1 | 0.05 |
| `data-glass-lens` | 凸透镜强度，0–0.6。玻璃中间的背景放大约 1 / (1 − lens) 倍，长条形只沿短边放大 | 0 |
| `data-glass-saturation` | 透射背景的饱和度倍数，0–3 | 1.3 / 1.15 |
| `data-glass-brightness` | 透射背景的亮度倍数，0.5–1.5 | 浅色 1.06、深色 1 / 1 |
| `data-glass-tint` | 十六进制染色值 | 随主题 |
| `data-glass-tint-alpha` | 染色比例，0–1 | 随主题 |
| `data-glass-specular` | 轮廓高光强度，0–2 | 0.7 / 0.9 |
| `data-glass-shadow` | 外侧阴影强度，0–1。画布渲染按背景亮度调整：暗背景与照片上更淡 | 0.16 / 0.12 |
| `data-glass-shadow-size` | 阴影范围，0–100 | 32 / 28 |
| `data-glass-layer` | 玻璃层级，值越大越靠前，只有同层玻璃会融合 | 0 |
| `data-glass-fusion` | 融合距离，0 表示关闭 | 32 |
| `data-glass-elevation` | 玻璃底面到背景的距离 | 16 |
| `data-glass-anchor` | 用于定位的祖先选择器 | `offsetParent` |
| `data-glass-morph` | 液体迁移，见下文。空值或 `true` 表示自身位置或尺寸变化时流动过去，其他值同时是迁移的名字；`false` 关闭（`true` / `false` 开关 0.3.0+） | 关闭 |
| `data-glass-morph-stretch` | 液体迁移的拉伸，0–2。0 表示整体平移，越大前缘与后缘拉得越开、拖尾越长 | 1 |
| `data-glass-morph-bounce` | 液体迁移的回弹，0–1。0 表示前缘不越过目标 | 0.33 |
| `data-glass-morph-wobble` | 液体迁移的晃动，0–1。到达时被压扁，随后在压扁与拉长之间振荡；0 表示不晃动 | 0.35 |
| `data-glass-morph-content`（0.3.0+） | 液体迁移期间玻璃上的内容：`static` 停在元素位置（尺寸过渡时随玻璃展开显露）；`clip` 停在元素位置并裁剪在体积内，相当于 `overflow: hidden`；`follow` 随体积一起拉伸、回弹和晃动 | `static` |
| `data-glass-materialize` | 生效与移除的过渡。出现（注册或由隐藏变为显示）时光线先弯折、再成为磨砂并略微越过；从 DOM 移除或隐藏时在原处退去。`none` 或 `false`（0.3.0+）关闭 | 开启 |

长度单位都是 CSS 像素，缺省一栏写作 `regular / clear`。`data-glass-lens` 与后五项只对画布渲染有效；折射、透镜和色散在 `css` 回退下不起作用。

### 参数作用域（0.3.0+）

给祖先加上 `data-glass-scope`，它上面的 `data-glass-*` 参数就成为其中所有玻璃的缺省值，类似 UI 库的 `ThemeProvider`。查找顺序是玻璃自身的属性 → 由近及远的作用域 → 全局默认参数，所以作用域可以嵌套，内层只覆盖它写出的参数。作用域元素本身不必是玻璃；只做包装时加上 `display: contents`，不影响布局。

```html
<section data-glass-scope data-glass-variant="clear" data-glass-layer="2" style="display: contents">
  <button data-liquid-glass>继承 clear 与第 2 层</button>
  <button data-liquid-glass data-glass-variant="regular">自身属性优先</button>
</section>
```

`data-glass-morph` 不从作用域继承：它的名字标识单块玻璃，传下去会让作用域里的玻璃都成为同一组迁移。作用域的参数变化时，其中的玻璃立即更新。

辅助属性（画布渲染）：

- `data-glass-clip`：加在普通祖先上，后代玻璃和阴影限制在它的矩形内。
- `data-glass-modal` 与 `data-glass-scrim`：模态层根节点和其中的遮罩。打开时模态层外的玻璃按遮罩透明度压暗。
- `data-glass-fade`：页面切换容器，其 `opacity` 作用到内部玻璃。
- `data-stage-overlay`：单独上传的透明前景层，用于需要插在玻璃之间的内容（例如跨越多块玻璃的过渡动画）。属性值是一个玻璃层级：`data-stage-overlay="5"` 盖住低于第 5 层的玻璃，被第 5 层及更高层的玻璃盖住；不写值时位于所有玻璃之上。需要在开始绘制前存在，一个页面一个。

### TypeScript 类型

`LiquidGlassAttributes` 列出上面所有属性和它们接受的写法：数值属性接受数字或数字字符串，`data-glass-variant` 只接受 `regular` / `clear`，`data-glass-tint` 要以 `#` 开头，开关属性（`data-liquid-glass`、`data-glass-scope` 等）接受空字符串、模板里不写值或布尔值。只有类型，没有运行时代码。

在 Vue 模板或 React JSX 里检查原生元素上的这些属性，把对应入口加进 tsconfig：

```jsonc
{
  "compilerOptions": {
    "types": ["liquid-in-canvas/vue"] // React 用 "liquid-in-canvas/react"
  }
}
```

也可以在任意 `.d.ts` 里写 `/// <reference types="liquid-in-canvas/vue" />`。之后 `<div data-glass-variant="frosted">` 会报错，补全会列出全部属性。这两个入口分别扩展 `vue` 的 `HTMLAttributes` 与 `@types/react` 的 `HTMLAttributes`，它们是可选的 peer 依赖。

把属性收在对象里再 `v-bind` / 展开时，给对象标上这个类型：

```ts
import type { LiquidGlassAttributes } from 'liquid-in-canvas'

const pill: LiquidGlassAttributes = { 'data-liquid-glass': '', 'data-glass-variant': 'clear', 'data-glass-blur': 1 }
```

0.3.0 起，开关属性可以直接绑定布尔值：框架把 `false` 渲染成字符串 `"false"`，舞台把值为 `"false"` 的约定属性当作不存在，与绑定 `undefined` 或 `null` 效果相同。

```tsx
<button data-liquid-glass={active} data-glass-morph={active && 'tabs'}>全部</button>
```

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
- 同一个元素的 `data-glass-morph` 为空值时，它自己的位置或尺寸变化（不含滚动和窗口缩放）也以同样的方式过渡，例如拖动一块玻璃：本体紧跟元素，后面拖出一团与它融合的液滴，方向就是拖动方向（包括斜向）；松手后本体越过落点再弹回，液滴甩过本体后收拢，晃动几下停下。拖尾需要非零的融合距离。位置按 `offsetLeft` / `offsetTop` 测量：拖动时要改变玻璃元素自己的 `left` / `top`（或布局位置），只移动外层容器或使用 `transform` 不会触发流动。
- 同名玻璃仍在页面上时，新出现的玻璃从它里面流出来，例如面板从按钮里长出来：两者同名，面板一步出现在最终位置，玻璃从按钮的位置和尺寸流向面板，内容随玻璃展开显露。面板移除时，它的体积流回按钮并被吸收。
- 用 `data-glass-morph` 过渡尺寸时，元素应一步切换到新尺寸，由玻璃负责过渡。逐帧改变元素尺寸会让画布每帧重建内容快照，文字和控件会闪烁。
- 玻璃停下时的回弹与晃动默认不带动内容。想让内容不超出晃动的玻璃，用 `data-glass-morph-content="clip"`；想让内容像贴在玻璃上一样跟着变形，用 `follow`。
- `data-glass-morph-stretch`、`-bounce`、`-wobble` 调整流动的手感，缺省值来自全局默认参数里的 `morphStretch`、`morphBounce`、`morphWobble`。
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

## 调参面板

`liquid-in-canvas/tuner` 提供一个不依赖前端框架的调参面板：可拖动的圆形玻璃入口，点击后展开面板，实时修改全局默认参数（材质、倒角截面与光路示意、融合、液体流动），“复制参数”得到的 JSON 可以直接传给 `setGlassDefaults()`。传入挂载结果时还能调整分辨率上限、自适应降级和光路，并显示实际倍率。

```ts
import { mountLiquidGlass } from 'liquid-in-canvas'
import { createGlassTuner } from 'liquid-in-canvas/tuner'

const glass = await mountLiquidGlass({ root })
// 框架应用挂载到 root 之后再创建，面板插入 root 末尾，画布模式下随根元素一起画出来。
const tuner = createGlassTuner({ mount: glass })

tuner.setHidden(true) // 模态界面打开期间隐藏入口
tuner.destroy()
```

- `container`：面板插入的元素，缺省为 `mount.root`，没有 `mount` 时为 `document.body`。画布模式下必须位于根元素之内。
- `renderer`：自定义“渲染方式”一节的数据来源（`GlassTunerRenderer`）。切换渲染方式需要 `dispose()` 后重新挂载，由你实现 `setMode`；`rendererFromMount(() => currentMount, { setMode })` 可以在重新挂载后跟随新的挂载。渲染器在面板之外变化时调用 `tuner.update()`。
- `locale`（`'zh' | 'en'`，缺省按 `<html lang>`）、`theme`（缺省与舞台一样跟随页面主题，调整的是当前主题的材质）、`layer`（展开时的玻璃层，缺省 1）、`zIndex`、`position`、`hidden`、`open`。
- 面板自带样式表（创建时插入 `<head>`），不依赖页面的 CSS 重置；颜色来自 `--lg-tuner-text`、`--lg-tuner-line`、`--lg-tuner-accent` 等自定义属性，在 `.lg-tuner` 上覆盖即可使用页面自己的配色。
- 入口与面板声明了同名的 `data-glass-morph`：画布渲染下面板的玻璃从入口里流出来，回退实现里用缩放过渡。

## 分辨率与性能

画布分辨率和玻璃着色分辨率分开控制。页面文字画在画布上，画布倍率低于设备倍率时文字会变软；玻璃后的背景本来就经过折射和模糊，单独降低它的着色分辨率几乎看不出来。

```ts
await mountLiquidGlass({
  root,
  resolution: {
    maxPixelRatio: 3, // 画布倍率上限，决定文字清晰度，缺省 3
    maxPixels: Infinity, // 画布像素总数上限，缺省不限
    maxGlassPixelRatio: 2, // 玻璃着色倍率上限，缺省 2
    adaptive: true, // 持续掉帧时自动降级（剖面光学 → 玻璃着色倍率），流畅后升回，缺省开启
    minPixelRatio: Infinity, // 允许自适应降级把画布倍率降到的下限；缺省 Infinity，不降低，文字不变软
  },
})

glass.stage?.setResolution({ maxGlassPixelRatio: 1.5 })
glass.stage?.getMetrics() // { dpr: 画布实际倍率, targetDpr: 降级前的画布倍率, glassDpr: 玻璃实际着色倍率, … }
```

- `adaptive` 按损失从小到大降级：`optics` 是 `hybrid` 或 `raymarch` 时第一级先改用 `profile`（只有融合连接处与裁剪边变成近似），之后调整玻璃着色倍率（每级 ×0.75，最低到一半）；设置了 `minPixelRatio` 时最后才降低画布倍率（每级像素数 ×0.75，慢得多时一级最多减半，文字随之变软）。升回时顺序相反。每降一级都会检验：绘制间隔没有缩短 1 ms 且 5% 以上就撤回这一级，并在一段时间内跳过这种手段，所以不会为了没有效果的降级损失画质。实际使用的光路与倍率见 `stage.getMetrics()` 的 `optics`、`glassDpr`、`dpr`。
- 整页快照、页面绘制和模糊的开销与画布像素数成正比，不受玻璃着色倍率影响。画布很大时（例如 5K 屏幕上的全屏窗口）浏览器把整页画进画布本身就跟不上，只有降低画布分辨率有效。自适应降级缺省不这样做，文字清晰度是底线；能接受文字变软时把 `minPixelRatio` 设为较小的值（例如 1，实际不低于 1 与设备倍率中的较小值），或用 `maxPixelRatio`、`maxPixels` 自己决定画布分辨率。画布倍率不会低于 1。
- `optics` 选择光路计算方式（`mountLiquidGlass`、`CanvasStage` 的选项，或 `stage.setOptics()`）：`profile` 按到轮廓的距离查预先沿截面追踪的光路；`raymarch` 在三维距离场里逐步求交。单块玻璃上两者结果一致，`profile` 在融合连接处与小圆角拐角是近似，GPU 开销约为 `raymarch` 的三分之一。`hybrid`（缺省）逐像素混合两者：只有一块玻璃的组查表，融合的组与被 `data-glass-clip` 切开的玻璃里只有连接处与裁剪边附近求交，静止的画面在这些地方与 `raymarch` 一致。
- `fieldCache`（`mountLiquidGlass`、`CanvasStage` 的选项，或 `stage.setFieldCache()`，缺省 `true`）只对 `hybrid` 有意义：连接处的求交结果（折射场）在几何静止约 0.1 秒后算一次并缓存，之后每帧读回、照常取样背景，视频与页面滚动不受影响；成员相对运动、按压或液体迁移期间这一组改用查表，停下后再求交并淡入。缓存按着色倍率分配，总量不超过 48 MB。设为 `false` 时连接处每帧逐步求交，运动中也与 `raymarch` 一致，开销随连接处的面积变化。
- 上层玻璃盖在下层玻璃上时，上层取样一张画好下层玻璃的背景（最多三级），只在需要的范围内额外合成与模糊；互不交叠时没有额外开销。
- 同层玻璃靠近或重叠时会并入同一个融合组，组内每个像素都要对所有成员求距离。大面积的面板请用 `data-glass-layer` 放到单独的层，避免和它下方的控件融合。

## 已知问题

- Chrome 157 的 HTML-in-Canvas 在计算滚动范围时，把 `canvas.updateElementGeometry()` 的平移叠加到 drawable 元素的布局位置上，位置被算了两次（命中测试是对的）。贴在视口右侧或底部的固定玻璃因此会把所在滚动容器撑大到约"位置 × 2 + 尺寸"，出现多余的滚动条。调参面板已经在 `.lg-tuner` 上用 `overflow: clip` 绕开；页面自己的固定玻璃可以放进一个铺满视口、`overflow: clip` 的 fixed 容器。随页面滚动的玻璃通常只多出很小的范围。详情与最小复现见仓库的 `docs/known-issues/drawable-scroll-overflow.md`。

## 其他导出

- `liquid-in-canvas/canvas`：`CanvasStage`，画布渲染器本身。需要自己管理画布时使用；`mountLiquidGlass` 在需要时动态加载它。
- `CssGlassStage`：回退实现本身，`refraction` 选项控制是否使用 SVG 滤镜。
- `glassProfile`、`glassProfileOutline`、`glassEdgeTilt`：由厚度与倒角参数算出玻璃的实际截面、截面轮廓线和边缘倾斜程度，渲染器和 SVG 滤镜使用同一套计算，可以用来绘制截面示意图。
- `liquid-in-canvas/vue`、`liquid-in-canvas/react`：只有类型，见上文 TypeScript 类型。
- `liquid-in-canvas/motion`：`advanceSpring`、`reducedMotionQuery`、`prefersReducedMotion`。玻璃按压使用的阻尼弹簧，页面自己的动画用同一套参数时手感一致。这个入口不引入画布渲染器。

## 范围

这是对 Apple Liquid Glass 视觉行为的 Web 近似，不是原生材质。同层融合用平滑距离场近似表面张力；不同层的玻璃按背景分级相互折射，超过三级的玻璃共用最高一级的背景。背景语义适配与设备姿态光照没有实现。设计说明见仓库的 `docs/`。
