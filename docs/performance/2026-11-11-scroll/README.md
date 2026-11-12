# 滚动卡顿：去掉颜色输出遍与着色器重建

2026-11-11，Chrome 157.0.8103.39，视口 1563 × 1013 CSS 像素，DPR 2，Apple Metal 3。基线为 `8a25e60` 的生产构建。

## 结论

滚动时主线程没有卡住，画布更新跟不上的原因是 GPU 吞吐。本轮做了两项改动，画面逐像素不变：

1. **省掉 three.js 的颜色输出遍。** 每帧 GPU 时间从 13.8 ms 降到 7.5 ms，减少约 45%。
2. **三维玻璃组按成员数量复用材质。** 冷启动后第一次滚动中，超过 16 ms 的绘制从 11 次降到 4 次（三轮合计）。

## 定位

用 CDP 发送真实滚轮事件，视频保持播放，统计画布 `paint` 事件和 `requestAnimationFrame` 的间隔。机器繁忙时（load average 约 3–4），基线的表现如下：

| 指标 | 数值 |
| --- | --- |
| `requestAnimationFrame` 间隔 | 16.7 ms，没有超过 33 ms 的帧 |
| 画布 `paint` 次数 | 每秒约 42 次，平均间隔 23.6 ms，约 17% 的间隔超过 33 ms |
| 每次绘制的主线程 JS | 约 2.6 ms（CPU profile），其中整页 `drawElementImageToTexture` 占 65% |

主线程有空闲，画布却跟不上，说明浏览器在等 GPU 完成上一帧。GPU 分项如下（`?gpu` 模式，每帧均值）：

| 阶段 | 基线 |
| --- | --- |
| 颜色输出（全屏，写入画布） | 6.1 ms |
| 场景（3126 × 2026，半精度中间纹理） | 5.1 ms |
| 十遍高斯模糊 | 2.0 ms |

### 颜色输出遍从哪里来

`renderer.outputColorSpace` 为 sRGB，而工作空间是线性。three.js 因此每帧都要先把整个场景画进一张全尺寸 RGBA16F 纹理，再用一遍全屏绘制转换成 sRGB 写到画布（`Renderer.needsFrameBufferTarget`、`_renderOutput`）。

### 着色器为什么反复构建

`VolumeGroups` 原先用成员编号组合（如 `3:7`）作为缓存键。滚动时可见玻璃不断进出，组合不断变化，每个新组合都会新建材质并重新构建 TSL 节点，超过 24 个还会被淘汰。预热后的滚动 profile 中仍有约 41 ms 的 `NodeBuilder.build`。

## 改动

- `src/stage/gpu.ts` 新增 `createSrgbCanvasOutput`：画布底层配置为 `bgra8unorm`，同时允许 `bgra8unorm-srgb` 视图；每帧画布纹理以 sRGB 视图写入，管线颜色格式同步改为 sRGB；`outputColorSpace` 设为线性。硬件在写入时编码 sRGB，混合仍在线性空间进行，three.js 不再创建中间纹理和颜色输出遍。首选画布格式不是 8 位时保持默认路径。
- `src/stage/liquid-glass/VolumeGroups.ts`：着色器结构只取决于成员数量，因此按数量分池复用实例，每帧重新写入全部 uniform。实例只增不减，数量不超过同时可见的玻璃数。

## 测量结果

两个版本交替运行，每侧三轮。

| 指标 | 基线 | 优化后 |
| --- | --- | --- |
| 每帧 GPU 时间（均值） | 13.49 / 13.81 / 14.01 ms | 7.45 / 7.50 / 7.57 ms |
| 场景 + 颜色输出 | 5.0 + 6.1 ms | 5.2 ms（直接写入画布） |
| 冷启动滚动中 > 16 ms 的绘制 | 4 / 4 / 3 次 | 2 / 1 / 1 次 |

测量期间机器负载较低（load average 约 2.4–3.0），两个版本在预热后的滚轮测试中都能达到约 60 帧，所以帧率本身没有差别。GPU 时间下降表现为余量：负载较高、GPU 被其他应用占用时，基线会降到约 42 帧，优化后仍有约 9 ms 的余量。本轮没有在高负载下做正式的交替对比。

## 画面一致性

两个版本都把视频暂停在第 1 秒，分别在滚动位置 0、1100、2300、3400 重新加载后截取全分辨率画面。逐像素比较，最大差值为 1–2 级（8 位），没有一个像素差超过 2，来自 8 位 sRGB 与 16 位中间纹理的取整差异。

## 尚未解决

- 冷启动第一次滚动时，两个版本的画布都只有约 45 帧，预热后能到 60 帧。差异与 GPU 和着色器无关，推测是浏览器首次栅格化懒加载的商品图片，需要用 Chrome 跟踪进一步确认。
- 剩余的长绘制是每种成员数量第一次出现时的着色器构建，可以考虑在空闲时预先构建 1–3 个成员的组。
- 自动化测量时发现，`Page.captureScreenshot` 之后浏览器会把滚动位置恢复到截图前的值。这是 CDP 的副作用，`tools/frames.mjs` 因此每个位置都重新加载页面。

## 复测

`tools/` 中的脚本通过远程调试端口驱动一个独立配置目录的 Chrome：

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/liquid-chrome --remote-debugging-port=9333 --no-first-run --window-size=1563,1100
```

按 `docs/performance/2026-11-07-scroll` 构建并预览 `tests/perf/scroll.html`，然后运行：

```sh
node docs/performance/2026-11-11-scroll/tools/wheel.mjs http://127.0.0.1:4181/ 2
```

- `wheel.mjs`：滚轮滚动，视频保持播放，统计 `paint` 与 `requestAnimationFrame` 间隔。`--cold` 记录冷启动第一轮，`--profile <file>` 保存 CPU profile。
- `cdp.mjs <url>?gpu 1 full`：调用测量页面的按钮，输出包含逐遍 GPU 时间的结果，可用 `gpusum.py` 汇总。
- `frames.mjs`：截取固定视频帧与滚动位置的画面，用于画面对比。

保存的原始记录已去掉逐遍数组：[GPU 时间](gpu-runs.json)、[冷启动滚轮](cold-wheel-runs.json)、[预热后滚轮](warm-wheel-runs.json)。
