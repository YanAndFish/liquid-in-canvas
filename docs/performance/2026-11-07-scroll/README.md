# 滚动掉帧调查

2026-11-07，在 HEAD `8ddbffb` 的生产构建上调查主页面滚动掉帧。掉帧已复现，两个着色器实验均未确认收益，生产代码已恢复。本目录保留测量记录，`tests/perf/scroll.ts` 提供独立滚动入口。

## 主要发现

在 1563 × 996 CSS 像素、DPR 2 的窗口中，五轮基线的平均动画帧间隔中位数为 32.65 ms，范围为 29.57 至 43.06 ms。每次绘制的同步 CPU 耗时中位数为 2.31 ms，范围为 2.12 至 2.66 ms。这里的帧间隔来自 `requestAnimationFrame`，不是屏幕实际呈现帧率。

独立 GPU 诊断的一轮预热后滚动获得 33 个已解析帧。各帧 render pass 时间之和平均为 22.47 ms，分项如下。

| 绘制阶段 | 平均 GPU 计时 | 目标尺寸 |
| --- | --- | --- |
| 最终颜色输出 | 10.65 ms | 画布 |
| 页面、玻璃和内容场景 | 7.90 ms | 3126 × 1992 |
| 十遍高斯模糊合计 | 3.65 ms | 782 × 498 至 98 × 63 |
| 被遮挡内容的背景合成 | 0.28 ms | 1563 × 996，仅重叠时执行 |

全尺寸场景与最终颜色输出合计约占 83%。这是单轮阶段定位数据，不能作为优化收益比例。颜色输出由 Three.js WebGPU 渲染器单独执行，调用链见 `Renderer._renderScene`、`_renderOutput` 和 `_getFrameBufferTarget`。GPU 时间通过 WebGPU timestamp query 获取，再按 `inspector.beginRender` 中的场景和目标尺寸对应到阶段。

这些时间不包含 HTML 快照上传的全部工作，也不能区分一个绘制阶段内部的算术、访存和等待。CPU 与 GPU 数据来自不同计时方式，不能相加计算单帧耗时。GPU 查询回读也会影响帧调度，因此它与关闭查询的常规滚动结果分开保存。

页面设备报告为 `vendor=apple`、`architecture=metal-3`、`isFallbackAdapter=false`。Chrome 内部 GPU 页面受浏览器工具策略限制，设备信息来自应用实际使用的 `GPUDevice.adapterInfo`。

## 两个实验的结果

候选 A 将玻璃中面的投影距离化简，并在投影距离大于 0.03 CSS 像素时跳过入射求交。阴影和出射计算保留。下面是每侧五轮交替测量的中位数。

| 指标 | 基线 | 候选 A |
| --- | --- | --- |
| 平均动画帧间隔 | 32.65 ms | 31.55 ms |
| 各轮平均帧间隔范围 | 29.57 至 43.06 ms | 31.24 至 41.03 ms |
| 每轮超过 50 ms 的间隔数 | 10 | 10 |
| 帧间隔 p95 | 50.00 ms | 50.00 ms |
| 每次绘制的平均 CPU 耗时 | 2.31 ms | 2.21 ms |

帧间隔中位数减少 1.10 ms，但变化小于轮间波动，五组中两组更慢，不能确认改善。独立的一组 GPU 诊断为 21.79 ms 与 21.72 ms，也没有显示明确收益。因此撤回候选 A。

候选 B 只处理独立玻璃的平坦中心。在法线垂直、且远离倒角和裁剪边缘时直接返回出射坐标。其余区域逐步求交。预热后单组 GPU 初筛为基线 21.78 ms、候选 21.39 ms。只有一组，差异不足以支持保留，未追加正式五轮测量，撤回候选 B。

数值检查中，A 覆盖 15,360 条光线，基线命中的 6,681 条均没有被提前跳过。B 覆盖 90,237 次快路径出射，基线的有效值与平面出射坐标均一致。这些是单精度 CPU 对照，不代替 GPU 像素级画面对比。两个候选都在 Chrome 完成首帧与滚动，未出现运行错误。

两项实验没有支持“局部光线求交是当前首要耗时”的假设。下一步应优先验证全尺寸中间纹理与颜色输出的成本，检查能否在保留线性混合与颜色结果的前提下减少整屏绘制。本次没有降低 DPR、减少模糊层或更改玻璃外观。

## 测量条件与限制

- Chrome 157.0.8103.39，8 核机器。一次负载检查中 load average 为 3.99，WindowServer 为 57.6% CPU。保留用户其他应用运行，采用交替测量减少负载漂移的影响。
- 视频暂停。测试用八秒沿 0、2200、0 CSS 像素路径往返滚动，每次导航后先完整预热一轮，再记录一轮。
- 每轮记录实际绘制次数、最大滚动位置、错误和视口。正式五组全部有效，错误数为零。计时期间关闭 DevTools，不运行构建与测试。
- 自动滚动用于提供一致路径，不能覆盖触控板惯性和所有浏览器输入调度。Chrome Performance 另录制了原生滚动，3.57 秒内有 149 次动画帧回调，出现约 21 至 36 ms 的 paint 事件。
- 原生滚动的 CPU 采样主要落在 `drawElementImageToTexture`，约 56.8 ms。玻璃内容上传约 4.3 ms，玻璃同步约 6.2 ms。这些是整段采样累计值，不能当作单帧耗时。Profiler 启动自身约 43 ms，不计为应用热点。
- 暂停视频后滚动可能缺失部分玻璃文字，基线能够复现。此次恢复生产代码，没有解决该绘制问题，也没有把缺失内容当作性能改善。

按 Explain the Number 原则，把 GPU 诊断和常规帧间隔分开。按 Attack the Premise 原则，在两个局部求交实验未显示明确收益后，改查整个绘制阶段，停止叠加着色器优化。

## 原始记录

- [候选 A 五组常规滚动](candidate-a-runs.json)
- [候选 A 单组 GPU 诊断](candidate-a-gpu.json)
- [候选 B 单组初筛](candidate-b-screen.json)
- [带绘制目标的 GPU 分项](pass-diagnostic.json)
- [设备信息与另一轮 GPU 诊断](adapter-diagnostic.json)
- [汇总数据](summary.json)

本机 Chrome 跟踪位于 `/private/tmp/liquid-scroll-perf/baseline-trace.json.gz`。候选源码和数值对照脚本位于 `/private/tmp/liquid-scroll-candidate-a/` 与 `/private/tmp/liquid-scroll-candidate-b/`。

## 复测

```sh
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-scroll-build --emptyOutDir
cp /tmp/liquid-scroll-build/tests/perf/scroll.html /tmp/liquid-scroll-build/index.html
pnpm exec vite preview --outDir /tmp/liquid-scroll-build --host 127.0.0.1 --port 4181
```

打开首页，等待页面完整显示。点击“往返滚动 8 秒”预热，再点击一次记录。在相同窗口中交替测量两个版本，每侧至少五轮。给结果添加 `version` 和 `round` 字段，再保存为 JSON 数组。

在地址后加 `?gpu` 可记录 GPU 时间、各遍绘制的时间和目标尺寸。该模式只用于定位，帧间隔与普通模式分开比较。

```sh
python3 tests/perf/summarize-scroll.py docs/performance/2026-11-07-scroll/candidate-a-runs.json
```

汇总脚本检查滚动是否经过规定范围、是否实际绘制、视口是否一致，以及是否混用了 GPU 诊断模式。少于五轮的版本会标记 `enoughRunsForComparison=false`。

## 工具检查

93 项测试、ESLint、类型检查、正式首页构建和独立性能页面构建通过。最终工具在 Chrome 中记录了 211 次绘制与 35 个 GPU 帧样本，运行错误数为零。该轮仅检查工具，不加入候选性能比较。

`git diff --exit-code -- src` 通过，生产源码相对任务开始版本没有改动。[测量页面截图](measurement-check.png)。
