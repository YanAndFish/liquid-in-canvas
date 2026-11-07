# Canvas 里的液态玻璃

阶段 03 把购物车抽屉和 showreel 面板做成 Apple 风格的液态玻璃。材质由 three.js WebGPU 的独立网格渲染，DOM 元素只需要 `data-liquid-glass` 和 `data-glass-*` 属性。

先说结论。

- 玻璃元素是嵌套的 `drawable`。主页面快照在它下面留空，元素内容单独捕获成透明纹理。
- 玻璃层从页面快照采样，做边缘折射、色散、可分离高斯模糊、染色、边缘高光和投影，再把清晰的 DOM 内容叠回去。
- 购物车抽屉完全玻璃化。showreel 用花视频和一层细网格作为背景，网格能让折射和边缘弯折更明显。

## 1. Apple 的设计要点

本阶段参考的资料：

- Apple，[Meet Liquid Glass，WWDC25 session 219](https://developer.apple.com/videos/play/wwdc2025/219/)。
- Apple，[Materials，Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials)。
- Apple Newsroom，[Apple introduces a delightful and elegant new software design](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)。
- [WWDCNotes 对 session 219 的整理](https://wwdcnotes.com/documentation/wwdc25-219-meet-liquid-glass/)。

真正影响 shader 的性质：

| 性质 | Apple 的描述 | 当前实现 |
| --- | --- | --- |
| 透镜 | 玻璃会弯折光线，不只是散射。 | 用 SDF 法线和 Snell 近似把背景采样点向面板内部偏移。 |
| 高光 | 高光会随材质和光源方向变化。 | 用方向性边缘高光和 Fresnel 亮带。 |
| 自适应染色 | 玻璃会吸收周围颜色，并把内容与背景分开。 | 背景先模糊，再以低比例混入主题染色。 |
| 投影 | 更大、更厚的元素会产生更明显的分离。 | 在网格的 padding 区域绘制柔和投影。 |
| Regular 与 Clear | Regular 会自适应和雾化，Clear 更透明，适合媒体背景。 | `data-glass-variant` 选择不同预设。 |
| 导航层 | 玻璃属于内容之上的控制层。 | 抽屉和 showreel 都是导航或媒体覆盖层。 |
| 不要玻璃叠玻璃 | 玻璃上放内容时用填充，不要再叠一块玻璃。 | 抽屉内容使用填充，showreel 卡片互不重叠。 |

抽屉从 64px 页头下方开始。这样可以避开页头右侧的购物袋按钮，不让抽屉关闭按钮和页面按钮重叠。玻璃上边缘仍会折射一点页头内容，这是正常的。

## 2. 参考项目的取舍

[`iyinchao/liquid-glass-studio`](https://github.com/iyinchao/liquid-glass-studio) 是 MIT 许可的 WebGL2 / WebGPU 液态玻璃实现。它有这些可复用部分：

- 圆角矩形 SDF 和超椭圆圆角。
- 用厚度和 Snell 近似计算边缘折射。
- 边缘使用清晰背景，中心使用模糊背景。
- Fresnel 和方向性 glare。
- 低比例 tint 和按通道偏移的色散。
- 多 pass 高斯模糊。

当前实现复用了 SDF、Snell 边缘折射、清晰与模糊的深度混合、色散、Fresnel、glare 和 tint 思路。没有复用单形状全屏渲染器、指针弹簧、形状合并和它自己的多 pass 实现。这里的背景是整页 HTML 快照，所以高斯模糊由项目自己渲染到两张半分辨率和四分之一分辨率的 render target 上。

## 3. 属性 API

参数解析在 `src/stage/liquid-glass/options.ts`，是纯函数，测试环境可以直接运行。

```html
<aside
  data-liquid-glass
  data-glass-anchor="#cart-shell"
  data-glass-radius="28 0 0 28"
  data-glass-blur="18"
  data-glass-refraction="26"
  data-glass-dispersion="0.36"
  data-glass-tint="#0b0d12"
  data-glass-tint-alpha="0.1"
  data-glass-specular="0.62"
  data-glass-shadow="0.55"
  data-glass-shadow-size="38"
>
  ...
</aside>
```

| 属性 | 默认值 | 范围 | 作用 |
| --- | --- | --- | --- |
| `data-liquid-glass` | 无 | 存在即可 | 标记玻璃表面，阶段会自动补 `drawable`。 |
| `data-glass-anchor` | offset 父元素 | CSS 选择器 | 用于稳定测量位置的非 drawable 祖先。 |
| `data-glass-radius` | `28` | 0 到 2000 | 一到四个圆角半径，顺序与 CSS 一致。 |
| `data-glass-blur` | 18 regular，8 clear | 0 到 80 | 模糊强度和 soft / heavy 模糊层的混合比例。 |
| `data-glass-refraction` | 24 regular，20 clear | 0 到 80 | 边缘透镜偏移量，单位是 CSS 像素。 |
| `data-glass-dispersion` | 0.3 regular，0.4 clear | 0 到 1 | RGB 三通道偏移差。 |
| `data-glass-tint` | 暗色 `#ffffff`，亮色 `#f7f2e8` | `#rgb` 或 `#rrggbb` | 混入玻璃的染色。 |
| `data-glass-tint-alpha` | 暗色 0.04，亮色 0.12 | 0 到 1 | 染色强度。 |
| `data-glass-specular` | 0.7 regular，0.9 clear | 0 到 2 | 边缘高光和 glare 强度。 |
| `data-glass-shadow` | 0.32 regular，0.26 clear | 0 到 1 | 投影透明度。 |
| `data-glass-shadow-size` | 32 regular，28 clear | 0 到 100 | 投影衰减和网格 padding。 |
| `data-glass-variant` | `regular` | `regular` 或 `clear` | 先选预设，再让显式属性覆盖。 |

抽屉按主题绑定染色、透明度和模糊。暗色用 `#0b0d12`、0.1、18px。亮色用默认奶油色、0.45、28px，因为亮色页面更容易透出背后文字。

## 4. 渲染流程

### 4.1 嵌套 drawable 快照

drawable 根是 `#app`。玻璃元素自己也带 `drawable`。

```text
canvas
  #app drawable                 根快照，玻璃面板位置为空
    aside[data-liquid-glass]    单独快照，保持透明背景
```

HTML-in-Canvas 规定 drawable 子树会排除嵌套的 drawable 后代。因此根快照会在玻璃面板处留下空洞，而面板自己的快照只包含文字、图标和控件。这是文字能保持清晰的原因。如果把整页纹理直接做模糊，文字也会一起糊掉。

### 4.2 两层可分离高斯

`src/stage/liquid-glass/blur.ts` 负责背景模糊。

- 根页面纹理尺寸是 2560×1800。soft 层缩到四分之一，640×450；heavy 层缩到八分之一，320×225。
- 每一层先做水平 17 taps 高斯，再做垂直 17 taps 高斯。两次一维高斯等价于一次二维高斯，但每个像素只需 34 次采样，而不是 17×17 次。
- render target 使用 `HalfFloatType`，避免 8 位模糊出现色带。
- 只有至少一个玻璃表面可见时才执行四遍模糊渲染。
- 玻璃 shader 在折射后的 `screenUV` 上采样 soft 和 heavy，再按 `data-glass-blur` 混合。

之前的版本在一个 pass 里做二维 17 点采样，那不是高斯，只是固定圆盘权重。画面会发白发奶，边缘还有采样带。现在换成了真正的可分离高斯。

### 4.3 片元计算

```text
local      面板局部坐标，单位 CSS 像素，y 向下
distance   圆角矩形 SDF
inside     面板内部为 1，外边为 0
depth      边缘为 0，到折射厚度处为 1
normal     SDF 有限差分梯度
offset     normal × Snell 边缘系数 × refraction / viewport
sharp      根纹理在折射位置的三通道采样
soft       四分之一分辨率高斯结果
heavy      八分之一分辨率高斯结果
frosted    mix(sharp, mix(soft, heavy, blurMix), depth × blurStrength)
glass      tint + 方向性边缘高光 + Fresnel + glare
final      mix(glass, content.rgb, content.a)
```

法线使用 SDF 的有限差分，而不是 `max(q, 0)`。旧实现的 `max(q, 0)` 在面板内部是零，导致法线为零，实际没有折射，只剩模糊和染色。这是效果看起来不对的主要原因之一。

边缘不再画固定宽度的白色线框。之前用 `line` 做 1px 到 2px 的 rim，看起来像 CSS border。现在用 `pow(1 - depth, 3)` 的 Fresnel 光带和方向性 glare，亮度从边界连续衰减到面板内部，没有硬边。

### 4.4 网格与锚点

每个玻璃表面有一个三平面网格，位于面板 NDC 矩形上，并按 `shadowSize` 向外扩。材质使用 `MeshBasicNodeMaterial` 和 TSL `colorNode`，透明、关闭深度测试、关闭深度写入、关闭 tone mapping。

`updateElementGeometry` 把元素边框映射到 canvas。`data-glass-anchor` 指定一个非 drawable 祖先，层用它的可视矩形加 `offsetLeft` / `offsetTop` 计算玻璃位置。

这里还有一个重要保护。平滑滚动到 collection 时，`getBoundingClientRect` 可能短暂落后于 canvas 根快照，玻璃卡片会在页头附近停留一两帧。现在会检查玻璃矩形是否与锚点矩形相交。卡片已经离开 showreel 框时直接隐藏网格，不会再浮在页头上面。

### 4.5 层级

- 普通页面玻璃网格的 `renderOrder` 是 10 以上。
- 购物车抽屉内部的玻璃网格固定为 1000，保证永远在页面玻璃之上。
- 抽屉打开时，页面玻璃网格的材质透明度会乘以购物车遮罩剩下的亮度。否则它们是独立网格，不会像根快照里的页面一样被遮罩压暗。
- 抽屉自己的表面在 `#cart-shell` 内部，不参与这次压暗。

### 4.6 视频时钟

`drawElementImageToTexture` 只复制当前快照。视频播放时，DOM 像素在变化，但 canvas 不会自动收到 paint。`CanvasStage` 监听 `play`、`pause`、`ended`，在视频播放期间用 `requestAnimationFrame` 持续 `requestPaint()`。showreel 离开视口后会暂停视频。

## 5. 踩过的坑

### 5.1 CSS transform 会让快照为空

drawable 元素带 `transform: translateX(50px) scale(1.2)` 时，Chrome 157 的 `drawElementImageToTexture` 返回全透明。

所以抽屉不能用 `translateX(100%)` 滑入，改为从 `right: -100%` 到 `0` 的布局过渡。页面路由的 `.page-view` 仍有 transform，但玻璃卡片已经有内容快照，层会读取页面透明度让它们跟着淡出。

### 5.2 元素自己是 fixed 时快照为空

最小探针里，drawable 元素自身 `position: fixed` 时快照为空。固定外壳加 `position: absolute` 的 drawable 面板可以正常捕获。抽屉结构就是：

```text
#cart-shell fixed
  aside absolute, drawable
```

### 5.3 WebGPU context 必须先创建

如果在 canvas 的 WebGPU context 初始化之前调用 `drawElementImageToTexture`，会报：

```text
containing canvas does not have a rendering context
```

`CanvasStage` 在 `init()` 里调用 `renderer.getContext()`，之后才允许上传。

### 5.4 离屏元素会带空快照

首次出现在视口外的 drawable 元素可能带着空 paint record。滚动进入视口不会自动补内容。showreel 卡片复现过，内容纹理的非空像素数是 0。

修复方式是 `kickPaint()`。表面第一次进入视口时加一个透明 box-shadow，强制子树重绘，下一个 paint 再上传。实测非空像素数从 0 变成 8403、740 和 7808。

抽屉也有同样问题。它注册时在 `right: -100%` 的离屏位置，层会等它进入视口后重绘，并在滑入结束后再上传一次。

### 5.5 不能给面板加不透明背景

玻璃面板的背景必须是透明的。否则背景色会被写进内容纹理，shader 会在玻璃上再盖一层实心矩形。抽屉的计算背景是 `rgba(0, 0, 0, 0)`。

### 5.6 法线在内部为零

旧实现用 `outside = max(q, 0)` 推导法线。圆角矩形内部 `q` 是负数，`max(q, 0)` 为零，法线也为零。结果是面板内部完全没有折射，只剩模糊和染色。

现在用 SDF 有限差分求梯度。内部靠近边缘时梯度非零，边缘折射才真正出现。网格线在这个版本里会明显弯折。

### 5.7 二维 17 点不是高斯

旧版本在一个 pass 里对圆盘采样 17 次，这不是可分离高斯，权重和半径也很难调。背景会发白发奶，边缘有带。

现在改为水平加垂直两次 17 taps 高斯，soft 层在四分之一分辨率，heavy 层在八分之一分辨率。玻璃片元只需要采样两张模糊纹理。

### 5.8 平滑滚动时的测量错位

当 showreel 框从 sticky 状态滚出时，`getBoundingClientRect` 可能领先或落后根快照。实测卡片 DOM 矩形在某一帧停在 `y = 96`，而 showreel 框已经在 `y = -592`，下一帧才跳到 `-142`。

现在玻璃矩形必须与锚点矩形相交才显示。离开 showreel 框的卡片不会再画到页头上。

### 5.9 视频帧不会自动触发 paint

播放视频不会自动让 canvas 重新上传。需要 `requestAnimationFrame` 加 `requestPaint()` 的视频时钟。时钟在暂停和组件卸载时停止。

### 5.10 不要玻璃叠玻璃

抽屉和 showreel 卡片可以重叠，但抽屉画在最后，采样的是不包含玻璃表面的根快照。卡片会被抽屉遮住，而不是在抽屉里再折射一次。

页头保持不透明。共享商品图 clone 和入袋 clone 在根快照里，玻璃页头会把它们盖住。要让页头玻璃化，需要先把 shared layer 提到玻璃层之上。

## 6. 实测数据

Chrome 157，1280×900 CSS 视口，DPR 2。

```text
canvas 位图                 2560 × 1800
soft 模糊目标               640 × 450
heavy 模糊目标              320 × 225
showreel 卡片内容纹理       544 × 331、544 × 292
showreel 胶囊内容纹理       229 × 75
购物车内容纹理              832 × 1672（416 × 836 CSS）
玻璃片元采样                2 次模糊 + 3 次清晰背景
模糊 pass                    4 遍，仅在玻璃可见时执行
根纹理上传                  每个 paint，约 4.6M 像素
内容纹理上传                 dirty 或首次可见时
```

抽屉滑入轨迹从 `x = 1980` 到 `x = 864`，约 360ms。抽屉最终位置是 `x = 864, y = 64, 416 × 836`。

showreel 平滑滚动的测量错位实测：

```text
showreel 框 y = -592 时，卡片短暂停在 y = 96
下一帧卡片才修正到 y = -142
```

锚点相交保护就是为这段状态加的。

## 7. 验证

浏览器验证使用 Chrome 157 和 CDP：

- 1280×900 暗色与亮色主题。
- 390×844 DPR 3 移动端。
- showreel 滚入 sticky 区域，视频播放，三块玻璃卡片显示清晰的文字和折射网格。
- 购物车空状态、有商品、结算确认和 Escape 关闭。
- 抽屉背景透明，内容纹理有文字和控件，`drawable` 属性存在。
- 平滑滚动到 collection 时没有玻璃卡片浮在页头。
- 窗口缩放到 900×700 后 canvas 为 1800×1400，抽屉和 showreel 仍对齐。
- 共享商品图过渡、入袋动画和返回列表滚动未回归。

构建检查：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 8. 文件

| 路径 | 作用 |
| --- | --- |
| `src/stage/liquid-glass/options.ts` | `data-glass-*` 纯解析器 |
| `src/stage/liquid-glass/blur.ts` | 两层可分离高斯模糊和 render target |
| `src/stage/liquid-glass/material.ts` | TSL 玻璃材质、折射、色散、染色、边缘高光和内容合成 |
| `src/stage/liquid-glass/LiquidGlassLayer.ts` | 表面发现、内容纹理、网格、锚点裁剪、脏标记和上传 |
| `src/stage/CanvasStage.ts` | 启动玻璃层、传递根纹理、转发 paint 变化和视频时钟 |
| `src/components/cart/CartDrawer.vue` | 玻璃抽屉、`right` 滑入、主题染色、遮罩 |
| `src/components/home/GlassShowcase.vue` | 花视频、网格和玻璃卡片 |
| `public/media/liquid-glass-flower.mp4` | 6 秒 720p showreel |
| `tests/stage/liquid-glass-options.test.ts` | 参数解析测试 |

showreel 视频来自 `liquid-glass-studio` 使用的花视频素材，原始来源标注为 Pixabay。参考项目本身是 MIT 许可。

## 9. 已知限制

- 玻璃片元使用固定两张模糊层级，`data-glass-blur` 是两层之间的混合和强度，不是任意半径的连续高斯。
- 在非常平滑的背景上，边缘折射不如高对比网格明显。showreel 的网格就是为展示折射加的。
- 亮色主题的抽屉需要更高的奶油色染色，否则背景文字会透出来；这会牺牲一些透明度。
- 玻璃元素不能带 CSS transform。需要动画时用布局属性，或者把 transform 放到非 drawable 祖先。
- 不支持玻璃叠玻璃折射。每块玻璃只采样页面快照，不采样其他玻璃网格。
- 页头保持不透明。要玻璃化页头，需要把共享过渡层移到玻璃层之上。
- 依赖 Chrome 157 对嵌套 drawable、离屏 paint record 和 `drawElementImageToTexture` 的行为。升级 Chrome 或 three.js 前要重新验证。
