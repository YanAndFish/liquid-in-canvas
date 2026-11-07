# 玻璃内容排序的性能记录

2026-11-07，在 Chrome 157.0.8103.39 的生产构建中测量。最终改动减少主线程读取 CSS 的开销。帧间隔没有确认改善，不能据此声称卡顿已解决。

## 最终算法

每次玻璃同步创建一次比较器。比较两个元素时，先通过 `parentElement` 找到它们共有的 DOM 路径。共有祖先的层叠上下文对两侧相同，因此跳过这些节点的 CSS。

从两条分开的分支向下查找，各自遇到第一个层叠上下文就停止。比较这两个上下文的 `z-index`，相同时按 DOM 顺序排列。DOM 路径和节点层级只在这次排序中缓存，下一次排序读取当前状态。

该算法保留项目现有的层叠判断规则。它没有扩展为完整的浏览器 CSS 绘制顺序实现。

跨帧缓存方案未采用。MutationObserver 无法覆盖动画中间值、伪类、媒体条件和 CSSOM 修改的全部样式变化。按几何交叠跳过排序也未采用，因为玻璃阴影和融合组的绘制范围超出控件矩形。

## 测量结果

“绘制 CPU”包含上传 HTML、同步玻璃、提交 GPU 命令的同步耗时，不包含 GPU 执行完成时间。“绘制间隔”是相邻 `draw()` 调用的间隔，不是屏幕实际呈现时间。

以下均为五轮结果的中位数。括号内是五轮均值的最小值与最大值。

| 指标 | 本轮开始的版本 | 最终版本 | 结论 |
| --- | --- | --- | --- |
| 每次绘制 CPU | 3.873 ms（3.261 至 4.094） | 3.135 ms（2.898 至 3.460） | 中位数降低 19.1% |
| 绘制间隔 | 41.713 ms（38.295 至 45.413） | 42.032 ms（38.692 至 45.515） | 范围重叠，没有确认改善 |
| 每轮超过 50 ms 的动画帧间隔数 | 23（18 至 44） | 28（18 至 49） | 范围重叠，没有确认改善 |

最终版本的绘制 CPU 在五组相邻对比中均低于基线。五轮均值的精确双侧秩和检验为 p=0.0317。这是本机结果，不代表不同机器上的收益比例。

第一步先尝试了单次排序内缓存完整层叠路径。与本轮开始的版本交替测量时，绘制 CPU 从 2.974 ms 降至 2.478 ms，中位数降低 16.7%。这组记录的机器负载与最终组不同，不能直接用两组数值计算第二步的整页收益。

第二步单独比较完整路径缓存与最终分支算法。测试使用页面中 5 个可见玻璃元素，每轮预热 100 次，再执行 1,000 次排序。

| 指标 | 完整路径缓存 | 最终分支算法 |
| --- | --- | --- |
| 每次排序的 CSS 读取次数 | 22 | 15 |
| 每次排序耗时 | 0.0409 ms（0.0403 至 0.0506） | 0.0290 ms（0.0279 至 0.0369） |
| 排序结果 | `1,2,3,0,4` | `1,2,3,0,4` |

排序耗时降低 29.1%，CSS 读取次数减少 31.8%。节省量约为每次排序 0.012 ms，不能把这个百分比解释为整页帧率提升。

## 条件与有效性检查

- 视口为 1563 × 996 CSS 像素，DPR 为 2。画质、视频、模糊级别和光线计算均相同。
- 每组按基线、候选交替运行。整页测量先预热 5 秒，再记录 8 秒。计时期间关闭 DevTools，也不运行项目构建和测试。
- 每轮都有实际绘制，画布存在，视频时间推进，运行错误数为零。原始记录保留绘制次数、视频时间、视口和错误。
- 开始的两次预备测量与后台测试重叠，没有纳入正式结果。
- 运行期间整机负载和绘制速度有漂移。一次进程检查中 WindowServer 为 83% CPU，Chrome GPU 进程为 31%。没有停止用户的其他应用。采用交替测量，保留所有正式样本。
- 第一阶段暂停视频后，8 秒内只有一次由测试控件交互触发的绘制。静止页面没有持续重绘。该结果未用于速度比较。

## Chrome DevTools 记录

先在 Performance 面板录制视频场景。8.99 秒的基线包含 375 次 paint 事件。原 `stackingPath` 的 CPU 采样累计约 253 ms，`drawElementImageToTexture` 约 125 ms。对应位置分别是内容排序读取祖先 CSS，以及上传 HTML 快照。

第一步优化的独立跟踪中，缓存路径函数采样约 14.7 ms，记录包含 191 次 paint。两份跟踪的时长和帧数不同，仅用来确认热点变化，正式耗时来自关闭分析器后的测量。

本机原始跟踪保存在 `/private/tmp/liquid-perf/`。文件包括 `baseline-trace.json.gz`、`candidate-trace.json.gz` 和 `final-trace.json.gz`。这些文件用于 Chrome Performance 的“加载跟踪记录”，不加入生产构建。

## Worker 与 OffscreenCanvas

OffscreenCanvas 可以在 Worker 中绘制。当前项目的 HTML 采样使用 `drawElementImageToTexture`，还要在主线程读取 DOM 位置、CSS 和更新点击区域。将渲染器移入 Worker，需要设计快照或图像的传递与几何同步，不能直接搬走当前热点。

玻璃折射和高斯模糊本身已经由 GPU 执行。Worker 能减少部分主线程命令提交，但不会减少这些 GPU 工作。本轮没有运行完整的 Worker 渲染器对照，因此没有声称 Worker 无效，也没有引入该架构。

参考 [Chrome 的 HTML-in-Canvas WebGPU 文档](https://developer.chrome.com/docs/web-platform/html-in-canvas/webgpu) 和 [OffscreenCanvas 文档](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)。

## 复测

性能页面独立于正式首页。按以下命令构建，把测试入口复制成输出目录的首页，再启动预览。

```sh
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-perf-build --emptyOutDir
cp /tmp/liquid-perf-build/tests/perf/index.html /tmp/liquid-perf-build/index.html
pnpm exec vite preview --outDir /tmp/liquid-perf-build --host 127.0.0.1 --port 4181
```

在 Chrome 打开首页，等待视频和玻璃出现。点击“记录 8 秒”测量整页。暂停视频后点击“测量内容排序”测量当前可见元素的排序。每个版本至少测量五轮，交替进行。把 JSON 保存为数组后，运行：

```sh
python3 tests/perf/summarize.py docs/performance/2026-11-07/final-runs.json docs/performance/2026-11-07/sort-runs.json
```

汇总脚本拒绝有错误、视频未播放、无实际绘制或两版本排序结果不同的样本。静止页面的结果只能用于检查是否持续绘制，不能作为动态场景的速度样本。

[最终整页原始记录](final-runs.json)、[排序原始记录](sort-runs.json)、[第一步原始记录](cached-path-runs.json)、[汇总数值](summary.json)。

## 功能检查与限制

93 项测试、ESLint、类型检查和生产构建通过。Chrome 中检查了客服按钮拖拽、与主按钮和顶栏融合、展开及关闭客服面板，未出现控制台错误。[交互截图](interaction-check.jpg)。

暂停视频后滚动时，主物信息牌等部分玻璃文字会缺失。未修改的基线与最终版本均可复现。该绘制问题独立于排序改动，本轮没有修复。复现截图保存在 `/private/tmp/liquid-perf/baseline-paused-scroll.jpg`。
