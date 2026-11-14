# 架构

仓库是一个 pnpm workspace，分成可发布的渲染库和演示商店两部分，另有一个只在仓库内使用的 ESLint 插件：

```
packages/liquid-in-canvas   渲染库：HTML-in-Canvas + WebGPU 舞台、CSS 回退、全局默认参数
apps/demo                   演示商店（Vue）：只通过 DOM 属性和库的公开 API 使用玻璃
tools/eslint-plugin-hot     热路径规则：*.hot.ts 里每帧执行的函数不得分配堆内存
docs                        设计记录、视觉依据与性能记录
```

库不认识任何 Vue 组件，没有运行时依赖：画布渲染器直接使用 WebGPU。演示商店只从 `liquid-in-canvas` 和 `liquid-in-canvas/motion` 两个入口引入，不引用库的内部文件；性能测量页和画面检查页另外从 `liquid-in-canvas/canvas` 直接使用 `CanvasStage`。

主入口不静态引入画布渲染器。`mountLiquidGlass()` 确认浏览器支持画布渲染后才动态加载 `CanvasStage`，只能使用回退实现的浏览器不会下载它（演示的生产构建里这一块压缩后 66 kB、gzip 23 kB；基于 three.js 时是 854 kB、gzip 232 kB）。

## 渲染库

```
src/index.ts            公开 API，不静态引入画布渲染器
src/canvas.ts           liquid-in-canvas/canvas 入口：直接导出 CanvasStage
src/mount.ts            mountLiquidGlass()：选择渲染方式、搭建与拆除
src/CanvasStage.ts      画布舞台：初始化、尺寸与分辨率、视频时钟
src/stage-frame.hot.ts  一帧的绘制：页面快照、前景、玻璃、画布遍
src/resolution.ts       画布倍率、玻璃着色倍率
src/adaptive.hot.ts     玻璃着色倍率的自适应缩放
src/css/                回退实现：backdrop-filter，加上可选的 SVG 位移滤镜
src/liquid-glass/       三维距离场、同层融合、内容遮挡、多级模糊、液体迁移、默认参数与属性解析
src/contract.ts         页面与舞台之间的 DOM 约定
src/render-order.ts     页面、各层玻璃与前景的绘制顺序
src/gpu.ts              WebGPU 设备与 sRGB 画布、管线表、元素纹理与离屏目标、逐遍计时
src/frame.hot.ts        每帧的 uniform、绘制列表、编码与元素上传
src/frame.ts            每帧编码用到的常量、类型与扩容（冷路径）
src/support.ts          能力检测
src/shared/, motion.ts  弹簧与减少动态效果查询，经 liquid-in-canvas/motion 导出
```

### 三种渲染方式

`mountLiquidGlass({ root, mode })` 返回统一的挂载句柄。

| 方式 | 实现 | 页面结构 | 效果 |
| --- | --- | --- | --- |
| `canvas` | `CanvasStage` | 创建 `<canvas content="drawable">`，根元素移入画布 | 折射、凸透镜放大、色散、同层融合、内容遮挡、按压形变、液体迁移 |
| `svg` | `CssGlassStage`（带折射滤镜） | 不变，另外在 `<body>` 末尾放一个隐藏的 `<svg>` 保存滤镜 | 模糊、染色、圆角、阴影，加上边缘折射、色散和按光照方向分布的轮廓高光 |
| `css` | `CssGlassStage` | 不变，只给玻璃元素写入自定义属性并安装一张样式表 | 模糊、染色、圆角、阴影、轮廓高光 |

`mode` 缺省为 `auto`：按 `canvas` → `svg` → `css` 的顺序使用浏览器支持的第一种；画布初始化失败或运行中出错时也会改用回退，并通过 `onFault` 说明原因。指定 `canvas` 时不做回退，由调用方处理错误；指定 `svg` 而浏览器不支持时得到 `css`。几种实现读取同一套 `data-glass-*` 属性、同一份全局默认参数和同一个主题来源（`liquid-glass/theme.ts`），切换时页面不需要改动。

### SVG 滤镜回退

`css/refraction.ts` 为每种尺寸与参数的玻璃生成一个滤镜，相同形状的玻璃共用。做法：

- **贴图**：逐像素按圆角矩形的有向距离算出到轮廓的深度和法线。偏移沿法线指向内部，在轮廓处最大，到偏折带内侧衰减为零；高光是贴着轮廓的细线，朝向左上光源的一侧最亮。
- **三张灰度图**：水平偏移、垂直偏移、高光各一张，在滤镜内部再放进红、蓝通道。浏览器把图片从 sRGB 转到显示器色彩空间（例如 Display P3）之后才交给滤镜，彩色像素的通道会相互串扰：中性值不再是 0.5，整块背景偏移几个像素，高光通道也会凭空多出一层白雾。灰度像素在转换前后不变。
- **顺序**：`backdrop-filter: blur() url()`，先模糊再位移，与体积着色器在折射后的位置取样模糊纹理一致。反过来写，模糊会把折射抹掉。
- **色散**：红、绿、蓝各位移一次，偏移量依次增大。
- **限制**：只有 Chromium 内核会把 SVG 滤镜作用到背景上，其他内核遇到 `url()` 会让整条 `backdrop-filter` 失效，所以要同时检测语法和内核。滤镜开销与面积成正比，面积超过 12 万 CSS 像素的玻璃只用模糊。尺寸变化期间先撤下滤镜，稳定 140 ms 后再生成。

没有同层融合、内容遮挡和按压形变。

### 全局默认参数

`liquid-glass/defaults.ts` 保存一份模块级的默认参数：圆角、融合距离、悬浮高度，以及 `regular` / `clear` 两种材质在深浅主题下的外观。`parseGlassOptions()` 先读元素属性，没有声明的取默认值。`setGlassDefaults()` 合并补丁、限制取值范围并通知监听者；画布舞台和 CSS 回退都订阅了变化，会重新解析所有表面。

### 帧流水线（画布）

浏览器的 `paint` 事件驱动一帧，舞台本身没有常驻循环。只有视频播放、按压弹簧和液体迁移运动时才逐帧请求重绘。

1. **页面快照**：`CanvasStage` 把整个根元素上传为纹理，同时作为全屏背景和玻璃的折射源。
2. **玻璃表面**（`LiquidGlassLayer.sync`）：测量每块 `[data-liquid-glass]`，按需上传其 HTML 内容。
3. **内容遮挡**（`content-order.ts`、`ContentBackdrop`）：按层级、层叠上下文与 DOM 顺序排序；被上层玻璃覆盖的下层文字写进背景的副本，参与模糊。
4. **多级模糊**（`blur.ts`）：对合成背景逐级做高斯卷积，σ 为 2/6/16/40/80 CSS 像素；本帧用不到的层不生成。
5. **三维体积**（`VolumeGroups`、`volume-shader.ts`）：同层邻近玻璃合成一个距离场，按 RGB 三条光路折射取样，再叠加凸透镜偏移。
6. **前景**（`CanvasOverlay`）：`[data-stage-overlay]` 单独上传，画在低层玻璃之上。
7. **画布遍**：页面快照、前景、体积与玻璃内容按绘制顺序画进画布。

### GPU 结构

渲染器直接使用 WebGPU，不经过通用的场景图。所有绘制都是“一个矩形 + 一段 uniform”，`gpu.ts` 围绕这一点组织：

- **顶点**：顶点着色器按 uniform 开头的矩形生成四个顶点，没有顶点缓冲。
- **uniform**：一帧内所有绘制项的 uniform 先写进同一块内存，提交前一次 `writeBuffer`，绘制时用动态偏移切换。没有逐对象的缓冲和绑定组。
- **绑定**：第 0 组是 uniform 与取样器，全帧共用；第 1 组是这次绘制取样的纹理，按纹理视图缓存。
- **管线**：按键缓存。体积着色器按成员数量生成，内容着色器按遮挡数量生成；滚动中成员或遮挡变化只会取用已有的管线。启动时在后台编译常见数量（体积 1–4 名成员、遮挡 0–2 块），第一次出现更大的数量时同步编译。
- **命令**：一帧只有一个命令缓冲，依次是背景合成、模糊、低分辨率体积和画布遍。
- **颜色**：HTML 快照是 `rgba8unorm-srgb`，取样时由硬件解码；离屏目标是线性 `rgba16float`；画布配置为 8 位格式，以 sRGB 视图写入，混合在线性空间进行，写入时编码，不需要额外的颜色转换遍。
- **出错**：设备丢失或出现校验错误时舞台停止绘制并调用 `onFault`，`mountLiquidGlass` 据此改用回退实现。
- **计时**：设备支持 `timestamp-query` 时，测量页可以打开逐遍计时（`StageGpu.timing`），平时不写时间戳。

### 热路径

滚动和动画期间每帧都会执行的代码放在 `*.hot.ts` 文件里，这些文件里的函数不得分配堆内存。规则由 `tools/eslint-plugin-hot` 检查（`hot/no-alloc`、`hot/no-closure`），说明见它的 README。

| 文件 | 每帧做什么 |
| --- | --- |
| `stage-frame.hot.ts` | 上传页面快照，组装画布遍，编码并提交 |
| `frame.hot.ts` | uniform 分配、绘制列表排序、渲染遍编码、元素上传 |
| `CanvasOverlay.hot.ts` | 上传前景层 |
| `adaptive.hot.ts` | 按绘制间隔调整玻璃着色倍率 |
| `liquid-glass/glass-frame.hot.ts` | 测量玻璃、决定上传、排列前后顺序、写入内容 |
| `liquid-glass/content.hot.ts`、`content-order.hot.ts` | 内容与遮挡轮廓的 uniform，HTML 绘制顺序 |
| `liquid-glass/ContentBackdrop.hot.ts`、`blur.hot.ts` | 被遮挡内容的背景合成，多级模糊 |
| `liquid-glass/VolumeGroups.hot.ts`、`fusion.hot.ts`、`cover.hot.ts` | 融合分组、体积 uniform、低分辨率分块合成 |
| `liquid-glass/flow.hot.ts`、`shared/spring.hot.ts` | 液体迁移与按压弹簧 |

做法：

- **对象池**：绘制项、分组、覆盖矩形、体积规划在池里复用；每块玻璃的矩形、体积、遮挡列表与裁剪数组在注册时创建（`liquid-glass/surface.ts`），每帧改写字段。
- **预先创建的描述对象**：渲染遍描述、动态偏移（`Uint32Array`）、元素上传的参数、画布纹理视图描述、`updateElementGeometry()` 的变换矩阵都在构造时创建。
- **管线按整数取用**：`PipelineTable.get(count)` 是一次数组读取，不拼字符串键，也不创建回调。
- **排序不用 `Array.prototype.sort`**：V8 的实现每次都分配工作数组，绘制列表与可见玻璃用插入排序。
- **冷路径分开放**：池的扩容、缓存未命中时创建对象、纹理尺寸变化写在普通文件里（`frame.ts`、`liquid-glass/pools.ts`、`blur-shader.ts`、`content-shader.ts`、`volume-shader.ts`、`surface.ts`、`LiquidGlassLayer.ts`），热路径只在少见情况下调用。
- **DOM 读取每帧每个元素只读一次**：定位基准、裁剪区域、淡入淡出容器的矩形与透明度按帧编号缓存（`ElementBox`）；可见性用返回布尔值的 `checkVisibility()`；快照尺寸只在元素或画布尺寸变化后重新读取。DOM 接口返回的对象由 Blink 的堆管理，只能等老生代 GC 回收，规则检查不到，这是它们单独处理的原因。

数据见[性能记录](performance/2026-11-13-webgpu/README.md#追加热路径不再分配)。

### 凸透镜

玻璃顶面按拱形隆起：沿短边方向是一条抛物线，沿长边方向只在两端一个短边半径的范围内下降。取样位置朝中心偏移，偏移与拱面坡度成正比，中间区域因此被放大约 1 / (1 − `lens`) 倍；长条形的玻璃只沿短边方向放大，相当于柱面透镜。两个方向的剖面相乘，偏移在整块玻璃内连续，并与倒角处的三维折射叠加。融合区域里透镜偏移和其他外观一样按平滑合并权重混合。

### 嵌套玻璃与液体迁移

外层玻璃里的 `[data-liquid-glass]` 是嵌套玻璃：只有体积，没有自己的内容快照（它的 HTML 已在外层快照里）。它与外层同层，画在外层体积之后、外层内容之前，不遮挡外层内容；只与同一外层里的嵌套玻璃融合。

`data-glass-morph` 打开液体迁移（`liquid-glass/flow.ts`）。体积矩形的四条边各有一根弹簧，朝运动方向的边刚度大、先到并略微越过目标，背向的边刚度小、被拖在后面；体积被拉长时另一个方向按面积守恒的一半收窄。弹簧在元素的布局坐标里运动（定位基准内的 `offsetLeft` / `offsetTop`），滚动不会触发流动。两种来源：

- 同一个元素的布局位置或尺寸变化。
- 同名玻璃交接：带名字的玻璃注销后 400 ms 内同名玻璃注册，新玻璃从旧体积的位置出发。同一批 DOM 变更里两条记录的先后不固定，先注册的一方直接取仍在登记中的旧表面。

窗口尺寸变化引起的重新排版不算迁移，体积直接到位；系统要求减少动态效果时也直接到位。

### 逐像素开销

整页快照和玻璃着色的开销都与画布像素数成正比，体积着色器是最贵的一遍。它按像素位置分三种情况：

- **轮廓之外**：投影距离大于零的像素不可能与实体相交，只画阴影。
- **平顶区域**（`glass_slab`）：像素落在某个成员的倒角内侧，且其余成员远到不参与平滑合并。实体在这里是等厚平板，光线垂直穿过，直接取样。
- **倒角与融合区域**：逐步求交，三条光路各追踪一次（色散为零时只追踪一次）。

模糊取样只读取参与插值的相邻两层。这些捷径与完整求交的结果一致，见[性能记录](performance/2026-11-13-fill-rate/README.md)。

同层玻璃靠近或重叠时会并入同一个融合组，组内每个像素都要对所有成员求距离。大面积的面板应该放到单独的层，避免和它下方的控件融合。

### 分辨率

画布分辨率与玻璃着色分辨率分开控制。

- **画布倍率**决定整页文字和玻璃上文字的清晰度，只受两个静态上限约束：`maxPixelRatio`（默认 3）和 `maxPixels`（默认不限），结果不低于 1。
- **玻璃着色倍率**不超过画布倍率和 `maxGlassPixelRatio`（默认 2），再乘以自适应缩放。低于画布倍率时，体积组改画进低分辨率的离屏目标，再放大合成回画布（`VolumeGroups.compose()`）。玻璃后的背景本来就经过折射与模糊，降低后主要是轮廓和高光略微变软。
- **自适应缩放**只作用于玻璃着色倍率：连续两个窗口（各 45 帧）平均间隔超过 19.5 ms 时降一级（×0.75，最低 0.5），流畅 4 秒后尝试升回，升回失败则把下次尝试推后一倍。它不改变画布尺寸，文字不会因此变糊。

合成只覆盖体积组的包围矩形。离屏目标里各组已经相互混合，重叠的包围矩形先换成互不重叠的矩形（`cover.ts`），否则重叠处的阴影会叠加两遍。体积组按前景层的绘制顺序分成两段，各用一个离屏目标，前景层仍然夹在两段之间。低分辨率下一段内的所有体积先于这一段的内容绘制，上层玻璃的阴影因此不再压暗下层玻璃上的文字。

玻璃着色之外的开销（整页快照、页面绘制、模糊）不受玻璃着色倍率影响，只能靠降低画布倍率减少，代价是文字变软，由接入方通过两个静态上限决定。快照纹理、模糊层和玻璃内容纹理的尺寸互相独立，改变画布倍率不影响点击命中。

### 隐式组件

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| DOM 约定 | `contract.ts` | 页面与舞台之间的全部属性 |
| 绘制顺序 | `render-order.ts` | 页面、各层玻璃、前景的 renderOrder 区间 |
| 元素纹理 | `gpu.ts`、`frame.hot.ts` | HTML 快照纹理的创建与释放；每帧的上传 |
| 管线表 | `gpu.ts` `PipelineTable` | 按成员数量与遮挡数量缓存着色器，滚动中不重新编译 |
| 液体迁移 | `liquid-glass/flow.hot.ts` | 四边弹簧，体积在布局坐标中流向新位置 |
| 热路径规则 | `tools/eslint-plugin-hot` | `*.hot.ts` 里每帧执行的函数不得分配 |
| 快照调度 | `LiquidGlassLayer` 内 `dirty` / `settleFrames` / `paintPending` / `contentComplete` | 决定何时向浏览器请求新的绘制记录、何时上传 |
| 模态压暗 | `[data-glass-modal]` + `[data-glass-scrim]` | 模态层打开时压暗其外部玻璃的染色和高光 |
| 页面淡入淡出 | `[data-glass-fade]` | 页面切换时把容器 opacity 传给内部玻璃 |
| 按压形变 | `fusion.ts` `pressedBox` | 体积距离场与内容遮挡共用的按压轮廓 |
| 主题 | `liquid-glass/theme.ts` | 固定主题 → `<html data-theme>` → 系统配色 |
| 弹簧 | `shared/spring.ts` | 玻璃按压与页面菜单动画共用的阻尼弹簧 |
| 减少动态效果 | `shared/motion.ts` | 系统设置查询，供舞台、弹簧、视频和共享动画使用 |

## DOM 约定

舞台只通过以下钩子认识页面。修改时同步 `packages/liquid-in-canvas/src/contract.ts`。

| 钩子 | 舞台行为 |
| --- | --- |
| `[data-liquid-glass]` + `data-glass-*` | 注册为玻璃表面，参数见包的 README；嵌套在另一块玻璃里时只绘制体积 |
| `[data-glass-clip]` | 限制后代玻璃与阴影的绘制范围 |
| `[data-glass-modal]` | 模态层根节点，内部玻璃不被压暗 |
| `[data-glass-scrim]` | 背景色 alpha × 模态层 opacity 决定压暗强度 |
| `[data-glass-fade]` | opacity 作用到内部玻璃 |
| `[data-stage-overlay="L"]` | 单独上传的透明前景层，盖住低于第 L 层的玻璃，被第 L 层及更高层的玻璃盖住；不写值时位于所有玻璃之上。需要在舞台 `start()` 之前存在 |

回退实现只使用第一行；裁剪、压暗和淡入淡出由浏览器按普通 DOM 处理。

## 绘制顺序

| 顺序 | 内容 |
| --- | --- |
| 0 | 页面快照 |
| 900 + 10·L … +0.5 | 第 L 层玻璃的体积组 |
| 900 + 10·L + 1 … +2 | 第 L 层玻璃上的 HTML 内容 |
| 900 + 10·L − 0.5 | 声明在第 L 层的前景层 |

演示商店的导航和页面玻璃使用第 0 层，展开的调参面板使用第 1 层，购物袋使用第 10 层，前景层声明在第 5 层，所以商品动画位于前两者之上、购物袋之下。`tests/stage/render-order.test.ts` 检查这些区间不重叠。

## 演示商店

```
src/main.ts                 启动：能力检测、渲染方式控制器、说明页
src/pages, src/components   Vue 视图：只通过 DOM 属性声明在舞台中的角色
src/composables, src/stores 视图状态：主题、语言、弹簧、购物袋、共享动画、渲染方式、默认参数
src/domain, src/i18n        纯业务逻辑：商品、金额、购物袋计算与持久化
src/shared                  偏好存储与滚动容器
```

### 启动与渲染方式

`main.ts` 先检测能力。支持时以 `canvas` 方式挂载商店；不支持、初始化失败或运行时出错时卸载商店并显示 `UnsupportedView`。演示不使用 `auto`：说明页上有“使用回退版本继续”按钮，由用户决定是否以 `svg` 方式重新挂载（浏览器不支持滤镜时库自动使用 `css`）。

`RendererController`（`composables/useRenderer.ts`）通过 provide 交给调参面板，用来在应用保持挂载的情况下切换渲染方式和调整分辨率。切换时根元素在文档中移动，控制器负责恢复滚动位置和视频播放。

商店内部还有三个不经过舞台的约定：`#stage-scroll`（唯一滚动容器，见 `shared/scroll.ts`）、`[data-product-image]`（共享动画的起点和终点）与 `[data-bag-target]`（加入购物袋动画的终点）。

## 测试与诊断

- `packages/liquid-in-canvas/tests`：Vitest + jsdom，覆盖属性解析、默认参数、分辨率、融合分组（含嵌套玻璃）、内容顺序、不重叠覆盖、液体迁移的弹簧与交接、回退实现（含折射滤镜的贴图取值）和不支持时的挂载行为。管线缓存、uniform 布局、绘制列表与玻璃图层的每帧逻辑用记录调用的假设备（`tests/helpers/fake-gpu.ts`）驱动真实代码检查。
- `tools/eslint-plugin-hot/tests`：热路径规则的正反用例。
- `apps/demo/tests`：领域逻辑与视图。
- `apps/demo/tests/visual/*.html`：在支持的浏览器中人工检查玻璃边缘与内容遮挡。
- `apps/demo/tests/perf/`：独立构建入口，通过替换 `CanvasStage.prototype.draw` 记录帧时间，`?gpu` 时打开逐遍计时，结果保存在 `docs/performance/`。`?lens=0` 关闭透镜，用于和没有透镜的旧版本逐像素比对（`docs/performance/2026-11-13-webgpu/tools/`）。

jsdom 不绘制 WebGPU，测试通过不能证明着色器的画面。画面需要在支持这些 API 的浏览器中检查。

## 相关文档

- [渲染库 README](../packages/liquid-in-canvas/README.md)
- [HTML-in-Canvas 实践记录](HTML_IN_CANVAS_NOTES.md)
- [液态玻璃设计与着色器](LIQUID_GLASS_NOTES.md)
- [Apple Liquid Glass 视觉依据](APPLE_LIQUID_GLASS_REFERENCE.md)
