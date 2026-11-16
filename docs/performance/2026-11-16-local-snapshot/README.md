# 局部快照：能否只获取玻璃需要的那部分页面

2026-11-16，Chrome 157.0.8103.39，Apple M1（Metal 3）。生产构建（基线 `15ea611`），高分辨率视口用 CDP 的 `Emulation.setDeviceMetricsOverride` 模拟，GPU 是同一台机器的，**没有在真机上测量**。浏览器用单独的临时配置启动（命令见文末）。

## 结论

- **整页快照不能换成只覆盖玻璃的局部纹理。** 页面快照不只是玻璃的背景，也是画布上显示的整个页面（绘制顺序 0 的那一次整页绘制）。`content="drawable"` 的画布不会由浏览器绘制子元素，玻璃以外的像素没有别的来源；只上传局部，其余部分就是黑的。
- **API 支持取子矩形、写入目标的局部**：`drawElementImageToTexture()` 有源矩形（`sourceX/Y/Width/Height`，CSS 像素）和目标起点（`destination.origin`）。Chromium 每次调用按目标尺寸新建一张表面，光栅化的像素数随源矩形面积下降。**但每多调用一次，就要再付一次与整页绘制记录复杂度成正比的固定开销**：演示用的测量页上约 10 ms 一次，与面积、分辨率无关。所以“整页一次 + 玻璃局部若干次”、按条带分块、按脏矩形补传都比现在更慢。
- **可行而且收益明显的是“页面没变就不上传”**：`paint` 事件的 `changedElements` 在 Chrome 157 里按 drawable 元素报告重绘，只有玻璃自己在动的帧里没有根元素。原型（`CanvasStage` 的 `snapshotReuse`，缺省关闭）在这些帧沿用上一帧快照：2560 × 1440 @3（33 MP）连续按压玻璃时，绘制间隔从 39 ms 降到 16.9 ms；@2 从 18.3 ms 降到 16.7 ms；滚动与视频播放时每帧照常上传，开销不变。
- **滚动时的瓶颈仍然在浏览器一侧**：滚动中页面每帧都变，整页必须重新光栅化才能显示。页面一侧唯一还能省的是“直接写进画布纹理、玻璃背景从画布局部拷贝”（方案 B），按 [文字清晰度记录](../2026-11-16-text-floor/README.md) 的分账最多省下 33 MP 时的一成，这次没有做。再往下要靠浏览器：复用光栅化表面、只重新光栅化变化的区域，或者在 `paint` 事件里给出变化的矩形。

## API 能力核实

出处（2026-11-16 读取）：

- 规范：[WICG/html-in-canvas README](https://github.com/WICG/html-in-canvas)（提交 `5d9d970`）的 IDL 与第 3、4 节。
- 改名与参数历史：[HTML-in-Canvas updates（Chrome 开发者博客）](https://developer.chrome.com/blog/html-in-canvas-ot-changes)。
- Chromium 实现（`main` 分支，与 157 的分支可能略有出入，下文的行为都在 157 上实测过）：
  [`gpu_queue.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgpu/gpu_queue.cc) 的 `drawElementImageToTexture`，
  [`canvas_rendering_context.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/html/canvas/canvas_rendering_context.cc) 的 `GetElementImage`，
  [`local_frame_view.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/frame/local_frame_view.cc) 的 `RunCanvasOnpaintSteps` / `DidPaintCanvasDrawable` / `RequestCanvasOnpaint`，
  [`paint_layer_painter.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/paint/paint_layer_painter.cc)。

| 接口 | 参数 | 能做什么 | 限制 |
| --- | --- | --- | --- |
| `GPUQueue.drawElementImageToTexture(source, destination)` | `source`：`{ source: Element \| ElementImage, sourceX, sourceY, sourceWidth, sourceHeight }`；`destination`：继承 `GPUImageCopyTextureTagged`（`texture`、`origin`、`mipLevel`、`colorSpace`、`premultipliedAlpha`），另有 `size` | 取元素边框盒里的一个子矩形，按 `size` 缩放后写到目标纹理的 `origin` 处 | 源矩形四项要么都给、要么都不给，单位是 CSS 像素（乘以元素的缩放倍率换成物理像素）；缺省 `size` 是源矩形按画布网格换算的尺寸。拷贝尺寸只夹到纹理尺寸、**不扣除 `origin`**，越界会产生 WebGPU 校验错误，调用方要自己夹取。只能取一个元素（连同它的 drawable 子树，不含嵌套的 drawable），不能挑子元素；带 CSS `transform` 或自身 `position: fixed` 的 drawable 快照为空（见 [实践记录](../../HTML_IN_CANVAS_NOTES.md#17-阶段-03-补充液态玻璃)） |
| 实现方式（Chromium） | | 每次调用：取这个 drawable 最近一次的绘制记录，`AcceleratedStaticBitmapImage::CreateFromRaster(dest_size, …)` 新建一张目标尺寸的共享图像，缩放、平移后回放整份记录，再 `CopyTextureForBrowser` 到目标 | 没有跨调用复用表面，也没有只回放变化部分。[文字清晰度记录](../2026-11-16-text-floor/README.md) 在追踪里看到的每帧一次 `OnCreateSharedImage` / `OnDestroySharedImage` 就是它 |
| `CanvasRenderingContext2D.drawElementImage(element, sx, sy, sw, sh, dx, dy, dw, dh)` | 四种重载 | 2D 上下文的同类接口，源矩形可以外扩以包含溢出的墨迹 | 一块画布只有一种上下文；舞台用 WebGPU，不能混用 |
| `WebGLRenderingContext.texElementSubImage2D(target, level, xoffset, yoffset, element, { sx, sy, swidth, sheight, width, height })` | | WebGL 的同类接口，有目标偏移 | 同上 |
| `captureElementImage(element)` → `ElementImage` | | 取得最近一次快照的引用，可以转给 Worker 画进 `OffscreenCanvas` | 只能画进同一块画布（或它转出的 `OffscreenCanvas`），否则抛 “captured from a different canvas” |
| `paint` 事件的 `changedElements` | | 这次渲染更新里重新绘制过的 drawable 后代 | 只到元素粒度，没有矩形。Chromium 在绘制某个 drawable 的层时，若“自身或后代需要重绘”就把它加入列表，所以嵌套 drawable 重绘时外层也会列出；`requestPaint()` 不带元素 |
| `updateElementGeometry(element, { canvasTransform })` | | 只同步命中测试与无障碍的位置 | 与绘制无关，改变它不会触发 `paint` |

规范还明确：canvas 元素自身的变换不参与绘制；drawable 元素隐含 `isolation: isolate` 并成为所有后代的包含块；`drawElementImage()` 对非 drawable、尚无快照或位于其他画布下的元素抛异常。

### `changedElements` 在 Chrome 157 里的实际内容

`tools/changed.mjs` 在演示首页（视频暂停）上逐项触发，统计每个 `paint` 事件的列表（ROOT 是舞台根元素，glass 是玻璃）：

| 触发 | `paint` 次数 | 列表 |
| --- | --- | --- |
| 静止 | 0 | |
| 只调用 `requestPaint()` 5 次 | 4 | 全部为空 |
| 内层容器 `scrollTop` 连续改 10 帧 | 18 | ROOT 12 次，空 6 次（舞台自己的补帧） |
| 页面图片的 `transform` 过渡 400 ms | 25 | 全部 ROOT |
| 页面文字的 `opacity` 过渡 400 ms | 20 | 全部 ROOT |
| 改页面里的文字 | 1 | ROOT |
| 改玻璃里的文字 | 1 | glass, ROOT |
| 播放视频 500 ms | 16 | ROOT 15 次，glass + ROOT 1 次 |

页面有变化的帧都带 ROOT，只请求重绘的帧为空，与读源码的结论一致。

## 实测：源矩形面积与调用次数

`tools/subrect.html` 是不依赖仓库代码的探针：根元素里 600 张带文字、圆角与阴影的卡片，每个 `paint` 事件按参数上传后把纹理拷进画布，统计 4 秒内的平均绘制间隔与“提交 → GPU 完成”的平均延迟。`scroll=1` 时每帧滚动内层容器，绘制记录每帧都变。原始数据在 `probe-runs.jsonl`。

2560 × 1440 @2（14.7 MP），每帧滚动，两轮平均：

| 每帧上传 | 上传面积 | 绘制间隔 | 提交 → 完成 |
| --- | --- | --- | --- |
| 不上传（只拷贝与呈现） | 0 | 16.7 ms | 4.6 ms |
| 整个根元素（现状） | 1 | 20.4 ms | 81.4 ms |
| 1 块，各占 50% | 0.5 | 18.6 ms | 42.3 ms |
| 1 块，各占 25% | 0.25 | 17.9 ms | 34.4 ms |
| 1 块，各占 10% | 0.1 | 17.0 ms | 26.8 ms |
| 1 块，各占 0.5% | 0.005 | 16.7 ms | 19.5 ms |
| 2 块，各占 0.5% | 0.01 | 25.7 ms | 51.1 ms |
| 4 块，各占 0.5% | 0.02 | 47.2 ms | 94.0 ms |
| 8 块，各占 0.5% | 0.04 | 89.9 ms | 178.0 ms |
| 3 块，各占 10% | 0.3 | 36.7 ms | 73.3 ms |
| 10 块，各占 2% | 0.2 | 112.2 ms | 224.4 ms |

对照：

| 条件 | 每帧上传 | 绘制间隔 | 提交 → 完成 |
| --- | --- | --- | --- |
| 根元素里只有背景（`content=blank`），14.7 MP | 整个根元素 | 16.7 ms | 13.9 ms |
| 同上 | 4 块，各占 0.5% | 16.7 ms | 7.1 ms |
| 1563 × 1013 @2（6.3 MP），600 张卡片 | 整个根元素 | 16.7 ms | 20.0 ms |
| 同上 | 4 块，各占 0.5% | 44.6 ms | 88.6 ms |
| 不滚动（记录不变），14.7 MP | 整个根元素 | 20.8 ms | 82.3 ms |
| 同上 | 1 块，各占 10% | 16.8 ms | 20.1 ms |

- **一块源矩形的开销随面积下降**：提交到完成的延迟从整页的 81 ms 降到 10% 面积的 27 ms，下限约 19 ms（极小的矩形）。
- **每多一次调用，绘制间隔增加约 10 ms**，与面积（0.5% 与 10% 一样）和分辨率（6.3 MP 与 14.7 MP 一样）都无关，页面是空白背景时这部分几乎为零。所以这是一份与绘制记录复杂度成正比的固定开销：每次调用都要回放（多半还要序列化给 GPU 进程）整份记录，源矩形只裁掉光栅化的像素。这一点是从数据推断的，没有在追踪里逐项确认。
- 记录变与不变（滚动与否）对开销没有影响：浏览器不缓存上一次的光栅化结果。
- 子矩形调用写到 `origin` 时没有抛异常，也没有出现校验错误导致的中断；写入位置是否逐像素正确没有截图核对。

## 方案对比

“外扩”指玻璃取样会读到的轮廓以外的范围：折射、透镜与反射的余量是 `stackMargin()`（`厚度 + 3 × 悬浮高度 + 48` CSS 像素），模糊还要加上各级核半径之和（`blurReach()`，σ 取到 80 时约 385 CSS 像素）。

| 方案 | 可行性 | 代价与收益 | 对模糊、色散、视频、多层背景、滚动的影响 |
| --- | --- | --- | --- |
| **A. 只获取玻璃组包围矩形（加外扩）**，替换整页快照 | **不可行** | 玻璃以外的页面没有像素来源。若保留整页再为玻璃另传局部，第二次调用多付约 10 ms 固定开销，内容又与整页相同，没有意义 | — |
| **B. 整页直接写进画布纹理，玻璃背景从画布纹理拷局部**（`copyTextureToTexture`） | 可行，未做 | 省掉画布遍里整页的那次读写和一张整页纹理；浏览器一侧的新建表面、光栅化、拷贝不变。按 33 MP 的分账最多省一成。画布要加 `COPY_SRC` 与 `COPY_DST` 用途，可能影响合成器的直通路径（未验证）；探针用画布同格式（`bgra8unorm`）的纹理做目标可以上传，但没有试过直接写交换链纹理 | 背景纹理改成与画布同族的格式（`bgra8unorm-srgb`）才能直接拷贝。第 0 级模糊现在卷积整个视口，要改成按区域卷积（`BackdropBlur.plan()` 已经支持 `region`，上层背景在用）；区域 = 各组 `bounds` 加 `margin` 与 `blurReach()`。顶栏一直带模糊，区域接近“整页宽 × (顶栏高 + 2 × 385)”。色散的三条光路与透镜都在 `margin` 之内，不受影响。视频照常进整页快照。多层背景的 `valid` 范围要从“第 0 级 = 整个视口”改成第 0 级的拷贝区域，否则取样会读到区域外的旧像素。滚动时区域跟着玻璃移动，每帧重新拷贝，没有额外问题。内容遮挡（`ContentBackdrop`）与低分辨率合成的顺序要随之调整 |
| **C. 按层级或条带分块获取** | **不可行** | 条带要多次调用，每次付整份记录的固定开销；滚动时所有条带都变。把常变的区域（视频）拆成嵌套 drawable：外层仍会因为后代重绘出现在 `changedElements` 里，分不出外层自己有没有变，还是要重传整页 | — |
| **D1. 脏矩形补传** | **不可行** | API 不给变化的矩形；每块补传都付整份记录的固定开销；滚动时整页都是“脏”的。要先把纹理平移再补新露出的条带，还得确认这一帧只是纯平移（顶栏、固定元素、视频都会打破） | — |
| **D2. 页面没变时跳过上传** | **可行，已做原型** | 只在玻璃自己动画的帧省下整页光栅化（按压弹簧、液体迁移、折射场缓存的淡化、玻璃内容的补传）。滚动、视频、页面动画的帧不受影响 | 沿用的就是上一帧的完整快照，模糊、色散、多层背景都从它取样，结果与重新上传相同（截图逐像素一致，见下文） |
| **E. 玻璃以外的页面直接由浏览器绘制** | **不可行** | drawable 画布的子元素不由浏览器绘制；元素只能属于一块画布；把页面放到画布外面，`drawElementImage*` 就取不到它（只能取画布的后代）。页面在外、画布只做玻璃，等于回到 `backdrop-filter`（`svg` / `css` 回退实现） | — |

## 原型：快照复用

`CanvasStageOptions.snapshotReuse`（缺省 `false`）与 `CanvasStage.setSnapshotReuse()`。测量页用 `?reuse=1` 打开。

- 每帧是否上传由 `CanvasStage.draw()` 决定：开关关闭、舞台自己知道页面可能变了（`pageStale`）、或者 `snapshotChanged()` 发现 `changedElements` 里有根元素，都会上传。拿不到事件或列表时一律上传。
- `pageStale` 在这些情况下置位：快照纹理重建（尺寸、画布倍率变化）、根元素里的 `scroll` / `scrollend` / `load`、字体就绪、视频时钟的新帧，以及外部调用 `invalidate()` 和玻璃图层的 `onInvalidate`（DOM 变更、玻璃注册、尺寸、按下指针等）。前三项在 157 里浏览器本来就会报告，这里不依赖它。
- 只有玻璃自己的运动走新的 `onRedraw`：`LiquidGlassLayer` 的弹簧与液体迁移动画、折射场缓存等待或淡化、内容快照补传。这些路径只请求重绘，不置位。`setOptics()` / `setFieldCache()` 同样只请求重绘。
- 热路径不分配：`snapshotChanged()` 用下标遍历 `changedElements`（`[SameObject]` 的冻结数组，读取不创建对象）。

### 测量

`tests/perf/scroll.html` 新增 `?press=400`：停在页面顶部，每 400 ms 交替按下、松开视口里第一块玻璃（合成的指针事件，不触发 `:active` 样式），八秒内只有按压弹簧在动；输出里新增 `uploads.root`（整页上传次数）。`adaptive=0`，各两轮（`stage-runs.txt`）：

| 场景 | `reuse` | 绘制次数 | 整页上传 | 绘制间隔（均值 / P95） | 每次绘制的 CPU |
| --- | --- | --- | --- | --- | --- |
| 按压，1563 × 1013 @2（6.3 MP） | 0 | 480–481 | 480–481 | 16.7 / 17.6 ms | 2.3 ms |
| | 1 | 479–480 | 10 | 16.7 / 17.6 ms | 0.7 ms |
| 按压，2560 × 1440 @2（14.7 MP） | 0 | 437–440 | 全部 | 18.2–18.3 / 19.7–19.8 ms | 0.8 ms |
| | 1 | 479–480 | 10 | 16.7 / 17.6–17.7 ms | 0.6 ms |
| 按压，2560 × 1440 @3（33 MP） | 0 | 205–207 | 全部 | 38.7–39.2 / 41.3–42.6 ms | 1.1 ms |
| | 1 | 471–474 | 10 | 16.9–17.0 / 17.5–17.6 ms | 1.0 ms |
| 往返滚动，2560 × 1440 @2 | 0 | 466–475 | 全部 | 16.9–17.2 / 18.4–19.3 ms | 1.6 ms |
| | 1 | 473–475 | 全部 | 16.9 / 18.3–18.7 ms | 1.6 ms |

- 按压时整页上传只剩每次按下的那一帧（8 秒 10 次），33 MP 下从约 25 帧变成 60 帧。
- 滚动时每帧都上传，开销与关闭时相同，没有回退。
- 6.3 MP 时 `?gpu` 的逐遍时间从 5.0 ms 降到 3.8 ms；逐遍计时只覆盖舞台自己的几遍，下降多半是 GPU 不再被浏览器的光栅化占用，不能当作舞台本身变快。
- **画面**：`tools/compare.mjs` 停在 600 px，按下玻璃、100 ms 后让页面上的图片做 300 ms 的 `transform` 过渡、再松开，1.5 秒后截图。`reuse=0` 与 `reuse=1` 两张 1563 × 1013 的截图逐像素相同。

## 推荐

1. 保留整页快照作为显示与背景来源，不做局部获取、条带或脏矩形补传（多次调用的固定开销决定了它们只会更慢）。
2. 快照复用值得在更多交互上验证后改为缺省打开（见下面的未验证项）。它不改变任何画面结果，只在玻璃自己动画的帧省掉整页光栅化；高分辨率下这些帧原来最容易掉帧，也最容易触发自适应降级。
3. 方案 B 收益上限约一成，改动面大（背景格式、第 0 级模糊的区域、`valid` 范围、内容遮挡与低分辨率合成的顺序、画布用途），等滚动成为明确的瓶颈、或浏览器侧没有进展时再评估。
4. 向浏览器反馈：`drawElementImageToTexture()` 跨调用复用表面与光栅化结果、只重新光栅化变化的区域、在 `paint` 事件里给出变化的矩形，都能直接降低滚动时的开销；多次调用的固定开销也值得作为问题报告。

## 风险

- 快照复用依赖 `changedElements` 的语义。Chromium 只在 drawable 的层“自身或后代需要重绘”时列出它；只改绘制属性而不重绘的变化（例如合成器上运行的动画、滚动偏移）可能不在列表里。157 实测滚动、`transform` 与 `opacity` 过渡都会列出根元素，滚动、加载、字体、视频另外由舞台置位兜底；以后的版本若改变行为，复用会显示旧的页面，直到下一次有变化的帧。
- HTML-in-Canvas 仍在源试用阶段（到 Chrome 160），参数名已经改过两次。
- 子矩形写入 `origin` 时 Chromium 不扣除起点，越界会产生校验错误、舞台随之停止（`onFault`）。以后若用到子矩形，必须先夹取。

## 未验证项

- 没有在真机（5K 显示器、手机）上测量，只用 CDP 模拟视口。
- 快照复用：动图（GIF / WebP / APNG）换帧、文本光标闪烁、输入法、`:focus-visible` 焦点环、抽屉开合与调参面板展开期间是否每帧都列出根元素，没有逐项检查。这些都会改变页面的绘制，按源码应当列出，但没有实测。
- 视频播放时快照复用的表现只从 `changedElements` 推断（每个视频帧都列出根元素），没有单独测量。
- 方案 B 没有实现，收益是根据 [文字清晰度记录](../2026-11-16-text-floor/README.md) 的画布遍时间推算的；交换链纹理能否作为 `drawElementImageToTexture()` 的目标没有试。
- 多次调用固定开销的成因（回放还是序列化整份记录）是从数据推断的，没有用追踪逐项确认。

## 复测

隔离的 Chrome（临时配置，不影响日常配置）：

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/liquid-chrome-snapshot --remote-debugging-port=9437 --no-first-run --window-size=1563,1100 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
```

探针页（任意静态服务器）：

```sh
mkdir -p /tmp/probe && cp docs/performance/2026-11-16-local-snapshot/tools/subrect.html /tmp/probe/index.html
python3 -m http.server 4418 --bind 127.0.0.1 --directory /tmp/probe
```

```sh
CDP_PORT=9437 W=2560 H=1440 DPR=2 node docs/performance/2026-11-16-local-snapshot/tools/run.mjs probe "http://127.0.0.1:4418/?mode=sub&fraction=0.005&count=4&scroll=1"
```

舞台测量（从 `apps/demo` 构建）：

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/perf --emptyOutDir
cp /tmp/perf/tests/perf/scroll.html /tmp/perf/index.html
pnpm exec vite preview --outDir /tmp/perf --port 4417
```

```sh
CDP_PORT=9437 W=2560 H=1440 DPR=3 RUNS=2 node docs/performance/2026-11-16-local-snapshot/tools/run.mjs scroll "http://localhost:4417/?press=400&reuse=1&adaptive=0"
```

```sh
CDP_PORT=9437 node docs/performance/2026-11-16-local-snapshot/tools/changed.mjs "http://localhost:4417/"
```

```sh
CDP_PORT=9437 node docs/performance/2026-11-16-local-snapshot/tools/compare.mjs "http://localhost:4417/?reuse=1&adaptive=0" reuse1.png
```
