# HTML-in-Canvas 实现笔记

这份文档记录 STILL 把整页 DOM 放进 `<canvas content="drawable">` 并用 three.js WebGPU 合成时遇到的问题、根因和修复。目标读者是下一个维护这个 stage 的人。

## 1. 范围

- 整个商店页面，包括头部、产品网格、商品详情、页脚和购物袋，都作为实时 DOM 放在一块 canvas 里。
- canvas 只负责显示纹理。DOM 仍然是真实 DOM，命中测试、焦点、文本选择和可访问性由浏览器处理。
- 浏览器缺少 HTML-in-Canvas 或 WebGPU 时只显示支持提示页。没有普通 DOM 商店回退。
- 目标环境是桌面 Chrome 157 或更新版本。

## 2. 浏览器支持与检测

Chrome 157 稳定版支持这些能力：

```js
const canvas = document.createElement('canvas')
canvas.setAttribute('content', 'drawable')

canvas.content === 'drawable'
typeof canvas.requestPaint === 'function'
typeof canvas.updateElementGeometry === 'function'
typeof GPUQueue.prototype.drawElementImageToTexture === 'function'
```

只检查 `canvas.content` 不够。`content` 属性存在，不代表上传 API 存在。支持检测必须同时检查 `requestPaint`、`updateElementGeometry`、`navigator.gpu` 和 `drawElementImageToTexture`。

OpenCode 内置浏览器是 Electron 44 / Chromium 152。它可能暴露 `navigator.gpu`，但没有 HTML-in-Canvas，也没有元素上传 API。实际结果：

```text
HTML-in-Canvas  missing
WebGPU          available
Element upload  missing
```

所以检测结果必须是 unsupported，然后显示提示页。不能因为 `navigator.gpu` 存在就继续启动 stage。

`navigator.gpu` 只说明 API 存在，不说明 `requestAdapter()` 一定成功。适配器创建失败会进入 init 失败提示，而不是商店页面。

## 3. Canvas 内容布局

`content="drawable"` 的直接子元素会被 blockify，但使用静态定位。它们不会自动铺满 canvas。

错误做法：

```html
<canvas content="drawable">
  <div id="app" drawable>...</div>
</canvas>
```

如果 `#app` 是普通静态子元素，它的宽度由内容决定，常见结果是宽度只有几百像素，高度按内容撑开。后续纹理上传会把整页拉伸，文字和图片都会失真。

正确做法是给 drawable 根元素明确尺寸：

```css
#app[drawable] {
  width: 100dvw;
  height: 100dvh;
}
```

drawable 元素会成为后代的包含块。页面内部的 `position: fixed`、绝对定位和滚动容器都以它为准，而不是以文档视口为准。

## 4. 文档滚动消失

整页进入 canvas 后，文档不再滚动。`window.scrollTo`、`window.scrollY` 和浏览器的滚动恢复都不再控制商店页面。

解决办法是在 drawable 根元素里放一个内层滚动容器：

```html
<div id="app" drawable>
  <div id="stage-scroll">
    <header>...</header>
    <main>...</main>
    <footer>...</footer>
  </div>
</div>
```

```css
#stage-scroll {
  height: 100%;
  overflow-y: auto;
}
```

带来这些连锁改动：

- `position: sticky` 仍然有效，因为 `#stage-scroll` 是真正的滚动祖先。
- Vue Router 的 `scrollBehavior` 默认只滚动 `window`，必须改成滚动 `#stage-scroll`。
- 保存历史滚动位置也要自己实现。Vue Router 保存的是 `window.scrollX/Y`，在这里永远是 0。
- `scrollTop` 恢复和页面顶部重置使用 `behavior: 'instant'`。CSS 的 `scroll-behavior: smooth` 会让 `behavior: 'auto'` 也变成平滑滚动，后退恢复会先停在中间位置。
- hash 导航要自己计算目标相对滚动容器的偏移。项目使用 96px 偏移，和 `scroll-mt-24` 保持一致。

## 5. 购物袋、Teleport 和 fixed 定位

购物袋原来 `Teleport` 到 `document.body`。整页进入 canvas 后，Teleport 到 body 会让抽屉跑到 drawable 子树外面，canvas 纹理里不会出现它。

处理方式：

- 删除 `Teleport`。
- 把 `CartDrawer` 放在 `#stage-scroll` 的兄弟位置，仍然在 `#app` 里。
- 抽屉的 `position: fixed` 会相对 drawable 根元素解析。因为根元素正好铺满视口，视觉上仍然覆盖整个页面。
- 不要把抽屉放进路由切换的 `Transition` 包装元素里。页面切换时的 `transform` 会成为新的包含块，改变 fixed 后代的定位。

滚动锁也要改。原来的 `document.body.classList.add('is-locked')` 不再有用，因为 body 不是滚动容器。现在锁定 `#stage-scroll`。

## 6. 两个抽屉导致的布局偏移

抽屉打开时出现过两种不同的偏移。

### 6.1 416px 的整体左移

`#app` 原来使用 `overflow: hidden`。`overflow: hidden` 仍然是一个可滚动容器。抽屉入场动画从 `translateX(100%)` 开始，这段屏幕外位移制造了可滚动溢出。焦点移到关闭按钮后，浏览器把 `#app.scrollLeft` 设为 416px，正好是抽屉宽度。

实测：

```text
t=0    app.scrollLeft = 416
t=40   app.scrollLeft = 357
t=91   app.scrollLeft = 201
t=673  app.scrollLeft = 0
```

结果是页面内容在抽屉打开期间整体向左滑。

修复是把 drawable 根元素从 `overflow: hidden` 改成 `overflow: clip`：

```css
#app[drawable] {
  overflow: clip;
}
```

`overflow: clip` 不创建可滚动容器，所以 `scrollLeft` 不会再变化。抽屉仍然从右侧滑入，屏幕外部分被裁掉。

修复后 `app.scrollLeft` 全程为 0。

### 6.2 15px 的滚动条偏移

内层滚动容器锁定前是 `overflow-y: auto`。系统使用经典滚动条时，滚动条占 15px。锁定后 `overflow: hidden` 让滚动条消失，`clientWidth` 从 1265 变成 1280，居中的内容移动 7.5px。

修复是预留滚动条槽位：

```css
#stage-scroll {
  scrollbar-gutter: stable;
}
```

实测：

```text
修复前：clientWidth 1265 -> 1280，main.x 偏移 +7.5
修复后：clientWidth 1265 -> 1265，main.x 偏移 0
```

覆盖滚动条环境下槽位为 0，不受影响。

## 7. WebGPU 和 three.js

### 7.1 three.js HTMLTexture 在 Chrome 157 不可用

three.js r187 的 WebGPU `HTMLTexture` 路径检查的是 `copyElementImageToTexture`。Chrome 157 已经改用 `drawElementImageToTexture`，旧的 `copyElementImageToTexture` 不存在。结果是不会报错，也不会上传纹理，画面保持空白。

当前实现没有使用 `THREE.HTMLTexture`。做法是：

1. 通过 `renderer.backend.device` 拿到 `GPUDevice`。
2. 自己创建 `GPUTexture`，格式 `rgba8unorm-srgb`。
3. 用 `THREE.ExternalTexture` 包装这个纹理。
4. 把 `ExternalTexture` 赋给 `MeshBasicMaterial.map`。
5. 在 canvas 的 `paint` 事件里调用 `device.queue.drawElementImageToTexture`，然后渲染全屏三角形。

这仍然是 three.js 管线。three.js 负责 renderer、scene、material 和全屏 mesh，只有 HTML 纹理的上传由我们直接调用。

### 7.2 第一次上传前必须配置 canvas 上下文

如果只 `await renderer.init()` 就调用 `drawElementImageToTexture`，会得到：

```text
TypeError: drawElementImageToTexture(): containing canvas does not have a rendering context.
```

`renderer.init()` 不一定会访问并配置 canvas 的 WebGPU 上下文。第一次 `renderer.render()` 才会。必须在初始化后显式调用：

```js
await renderer.init()
renderer.setPixelRatio(1)
renderer.getContext()
```

`getContext()` 会执行 `context.configure`。之后第一次 `paint` 里的上传才会成功。

### 7.3 全屏三角形和方向

使用一个覆盖屏幕的三角形：

```js
geometry.setAttribute('position', new Float32BufferAttribute([
  -1, 3, 0,
  -1, -1, 0,
  3, -1, 0,
], 3))

geometry.setAttribute('uv', new Float32BufferAttribute([
  0, -1,
  0, 1,
  2, 1,
], 2))
```

相机是 `OrthographicCamera(-1, 1, 1, -1, 0, 1)`，`mesh.frustumCulled = false`。这个 UV 方向适合 `drawElementImageToTexture` 的左上角原点，不需要手动翻转。

纹理使用 `rgba8unorm-srgb`，`ExternalTexture.colorSpace = SRGBColorSpace`。上传时传 `colorSpace: 'srgb'`。如果格式和输出色彩空间不匹配，页面会整体变亮或变暗。

## 8. Canvas 尺寸和 DPR

canvas 的 bitmap 尺寸要和设备像素对齐，否则浏览器会二次缩放，文字发虚。

```js
const dpr = window.devicePixelRatio || 1
const pixelWidth = Math.round(canvas.clientWidth * dpr)
const pixelHeight = Math.round(canvas.clientHeight * dpr)
```

在 headless Chrome 里，`ResizeObserverEntry.devicePixelContentBoxSize` 返回了 CSS 尺寸，而不是设备像素。1280×900 的 canvas 在 DPR 2 下返回 1280×900，导致 bitmap 只有 1280×900，截图是 2560×1800，文字被放大。

不要盲信 `devicePixelContentBoxSize`。用 `contentRect` 乘以 `devicePixelRatio` 计算，或者对两个来源做一致性校验。

修复后：

```text
CSS:    1280 x 900
DPR:    2
bitmap: 2560 x 1800
```

改变 DPR、窗口大小或浏览器缩放后都要重新计算。`ResizeObserver` 监听 canvas 的 CSS 尺寸变化。

## 9. 窗口缩放闪烁

`renderer.setSize()` 会设置 `canvas.width` 和 `canvas.height`。设置这两个值会清空 canvas。原来的 `ResizeObserver` 回调里直接调用 `setSize()`，清空发生在 `paint` 之前。下一次 `paint` 才上传和重绘，中间可能有一帧只有清空后的画面。

修复是只记录待处理尺寸，在 `paint` 处理器开头应用尺寸，然后立刻上传和渲染：

```ts
private draw(): void {
  const pending = this.pendingSize
  if (pending && this.applySize(pending))
    this.pendingSize = null

  // upload and render in the same paint
}
```

实测顺序：

```text
修复前：width -> resize -> paint
修复后：resize -> width -> paint
```

清空和重绘现在在同一次绘制更新里，不再单独出现清空帧。

注意：缩放期间旧 bitmap 会先被 CSS 拉伸到新尺寸，最多持续一帧。想彻底避免拉伸需要额外的双缓冲或固定大纹理，当前没有做。

## 10. Paint 事件与 CSS 动画

页面进入 canvas 后，浏览器不会自动把 DOM 变化画到 canvas。所有更新由 `paint` 事件驱动：

```js
canvas.addEventListener('paint', () => {
  device.queue.drawElementImageToTexture(...)
  renderer.render(scene, camera)
})
```

CSS transition 和 keyframe animation 会持续触发 `paint`。实测一个 900ms 的 transition 触发了约 55 次 paint。不需要常驻 `requestAnimationFrame` 上传循环。

需要主动 `requestPaint()` 的情况：

- 内层滚动容器滚动。
- 窗口或 canvas 尺寸变化。
- 字体加载完成。
- 图片加载完成。
- 路由切换和抽屉开关的初始帧。

在 2560×1800 下，一次上传加渲染约 0.4 到 3ms。这个数字来自本机 Chrome 157。5K 屏幕或更复杂的 glass shader 需要重新测量。

## 11. 路由切换动画

路由切换使用 Vue 的 `<Transition>`，但有几个坑。

### 11.1 Transition 需要单一根节点

`HomeView` 的模板有三个根元素，是 fragment。直接把 `<component :is="Component" />` 放进 `<Transition>` 会没有稳定的单根节点。

解决办法是包一层 keyed wrapper：

```vue
<RouterView v-slot="{ Component, route }">
  <Transition name="page">
    <div :key="route.path" class="page-view">
      <component :is="Component" />
    </div>
  </Transition>
</RouterView>
```

### 11.2 key 用 path，不用 fullPath

key 必须是 `route.path`，不能是 `route.fullPath`。否则点击 `/#collection` 这样的 hash 链接也会重播整页切换动画。

实测 hash-only 导航时 `views = 1`，没有重新挂载页面。path 变化时 `views = 2`，旧页和新页同时存在。

### 11.3 旧页面绝对定位，页面容器裁剪

默认模式下旧页和新页会同时存在。如果两个都在正常流里，滚动高度会叠加。

当前做法：

```css
.page-stage {
  position: relative;
  overflow: clip;
}

.page-leave-active {
  position: absolute;
  inset: 0;
}
```

旧页离开时绝对定位，覆盖在新页上方淡出。`.page-stage` 用 `overflow: clip` 裁掉旧页超出新页高度的部分，避免压住页脚。

### 11.4 页脚会跟随新页高度跳变

旧页绝对定位后，页面容器高度立即变成新页高度。从首页切到详情页时，页脚从约 4052px 跳到 1688px。两个位置都在首屏下方，所以当前不可见。切到很短的 404 页面时，页脚可能跳进视口。

这是当前方案的已知取舍。要彻底消除需要给容器高度做动画，或者使用固定高度的页面容器。当前没有做。

### 11.5 Transform 会创建包含块

页面切换时 `.page-view` 上有 `transform`。这会成为 `position: fixed` 后代的包含块。购物袋抽屉必须留在 transition 外面，否则打开抽屉时 fixed 定位会改变。

## 12. 交互动画

已加入的传统 HTML + CSS 动画：

- 产品卡片 hover 上移 4px，图片容器缩放到 1.04。
- Hero 图片 hover 缩放到 1.02。
- 导航链接下划线从左侧展开。
- 购物袋行项目从右侧淡入，按 40ms 错开。
- 按钮按下缩放到 0.98。
- 筛选按钮按下缩放到 0.95。
- 加购图标在 `Added` 状态放大到 1.1。

这些动画都由 `paint` 事件同步到 canvas。实测：

- 产品卡片 hover 后 `article` 的 transform 为 `translateY(-3.91px)`，图片容器的 `scale` 为 `1.035`。paint 计数从 42 增加到 68。
- 导航下划线的 `::after` transform 从 `scaleX(0)` 变成 `scaleX(1)`。
- 购物袋行项目在 100ms 时 opacity 约 0.56，transform 约 `translateX(6px)`，600ms 后恢复到 1 和 0。paint 计数从 142 增加到 159。
- 路由切换 80ms 时存在两个 `.page-view`，paint 计数从 2 增加到 16，切换完成后为 25。

`prefers-reduced-motion: reduce` 的全局规则会把 transition 和 animation 时长压到 0.01ms，这些动画会立即结束。

## 13. 支持提示页

支持提示页 `src/pages/UnsupportedView.vue` 是普通 DOM，不创建 canvas，不初始化 WebGPU。

它显示：

- 当前浏览器标签，例如 `Electron 44 · Chromium 152`。
- HTML-in-Canvas、WebGPU、元素上传三项能力检查。
- 缺失项和可用项。
- 需要的浏览器版本。
- 重新加载、获取 Chrome、阅读 API 文档三个操作。
- init 失败或运行失败时的错误堆栈。

提示页支持中英文和明暗主题。它复用 `useLocale` 和 `useTheme`，不依赖 router 或购物袋 store。

## 14. 测试和验证

日常检查：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

当前 45 个 Vitest 测试全部通过。测试环境是 jsdom，不会加载 WebGPU，也不会挂载 stage。`App.vue` 和组件测试不导入 `CanvasStage`，所以 jsdom 不会因为缺少 `navigator.gpu` 失败。

真实浏览器验证使用 Chrome 157 加 CDP：

- 1280×900 CSS 视口，DPR 2，canvas bitmap 为 2560×1800。
- 12 个产品、主题切换、语言切换、滚轮滚动、粘性头部、商品详情、加购、购物袋焦点、Escape 关闭、演示结算、hash 导航、后退滚动恢复。
- 窗口缩放到 900×700，DPR 2，canvas 变成 1800×1400，抽屉保持对齐。
- 使用 `--disable-features=OverlayScrollbar` 复现经典滚动条偏移。
- 使用 `Page.startScreencast` 和 DOM 采样检查缩放和抽屉动画。

OpenCode 内置浏览器只用于确认提示页。它无法运行商店页面。

## 15. 已知限制和风险

- 没有 DPR 上限。2560×1800 下上传加渲染约 0.4 到 3ms，5K 屏或后续 glass shader 可能成为瓶颈。
- 页面切换时页脚会跟随新页高度跳变。短页面可能看到页脚移动。
- 浏览器 Find-in-Page 对内部滚动容器的滚动行为没有完整验证。
- Chrome 端到端检查目前是本地 CDP 脚本，不在 Ubuntu CI 里。
- three.js 版本固定在 0.187.0。`HTMLTexture` 的 WebGPU API 仍在变化，升级前要重新验证。
- `scrollbar-gutter`、`overflow: clip`、`100dvh` 都要求较新的 Chrome。目标环境是 Chrome 157，满足要求。
- 提示页只检查 `navigator.gpu` 是否存在。适配器创建失败由 init 失败路径处理。
- 页面切换的旧页被绝对定位并裁剪，旧页中如果有 fixed 元素需要单独评估。

## 16. 文件索引

| 路径 | 作用 |
| --- | --- |
| `src/stage/CanvasStage.ts` | three.js WebGPU renderer、ExternalTexture、全屏 mesh、paint 上传、resize |
| `src/stage/support.ts` | HTML-in-Canvas、WebGPU、元素上传的能力检测 |
| `src/stage/scroll.ts` | 内层滚动容器和购物袋滚动锁 |
| `src/stage/types.ts` | StageSupport、StageFault、StageMetrics |
| `src/types/html-in-canvas.d.ts` | 浏览器 API 和 `drawElementImageToTexture` 的类型声明 |
| `src/main.ts` | 支持检测、canvas 创建、商店挂载、失败提示 |
| `src/App.vue` | 内层滚动容器、路由切换 wrapper、购物袋位置 |
| `src/pages/UnsupportedView.vue` | 支持提示页 |
| `src/router/index.ts` | 内层滚动、历史位置保存、hash 偏移 |
| `src/components/cart/CartDrawer.vue` | 抽屉、滚动锁、行项目错开动画 |
| `src/styles/main.css` | stage、drawable 根、滚动容器、路由切换、下划线动画 |
| `src/components/product/ProductCard.vue` | 卡片 hover、图片缩放、加购按钮反馈 |
| `src/components/home/HeroSection.vue` | Hero 图片 hover 缩放 |
| `tests/stage/support.test.ts` | 能力检测测试 |
| `tests/app/UnsupportedView.test.ts` | 提示页测试 |
