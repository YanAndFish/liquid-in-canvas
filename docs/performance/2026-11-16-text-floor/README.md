# 文字清晰度作为底线：高分辨率下的开销去向

2026-11-16，Chrome 157.0.8103.39，Apple M1（Metal 3）。生产构建，`tests/perf/scroll.html` 暂停视频、往返滚动。高分辨率视口用 CDP 模拟，GPU 是同一台机器的，**没有在真机上测量**。

## 结论

- 自适应降级缺省不再降低画布倍率（`minPixelRatio` 缺省改为 `Infinity`）。画布倍率决定整页文字的清晰度，接入方显式设置 `minPixelRatio` 才会打开这一级。
- 画布像素数是瓶颈时，开销几乎全在浏览器把整页画进纹理的路径上。这部分大致按像素数计费，空白页也一样，我们自己的 GPU 遍只占约一成。不降低画布像素数、又能明显缩短帧间隔的办法，在页面一侧找不到。
- 真实设备里像素最多的常见情况是 5K @2（14.7 MP）。这里缺省的 `hybrid`（带折射场缓存）滚动约 18 ms，接近 60 帧，自适应不会动光路与玻璃倍率，文字保持设备分辨率。

## 开销去向：2560 × 1440 @3（33 MP），不画玻璃（`?glass=0`）

滚动中录 3 秒追踪（`tools/trace.mjs`，按线程汇总用 `tools/tsum.py`，GPU 进程主线程按事件自身时间汇总用 `tools/tgpu.py`）：

| 线程 | 忙碌占比 | 主要事件 |
| --- | --- | --- |
| GPU 进程主线程 | 99.3% | `IOSurfaceImageBacking::WaitForCommandsToBeScheduled::Dawn` 2724 ms（91%，等 GPU 排上队），光栅化解码与刷新约 120 ms |
| 渲染进程主线程 | 7.5% | |
| 合成线程 | 2.2% | |

- CPU 侧几乎空闲，GPU 满载：3 秒里只出了 71 帧（约 42 ms 一帧）。
- `SharedImageStub::OnCreateSharedImage` 与 `OnDestroySharedImage` 每帧各一次：浏览器每次 `drawElementImageToTexture()` 都新建一张画布大小的表面，光栅化后拷进我们的纹理。33 MP 时这张表面约 132 MB。
- 我们自己的 GPU 遍（时间戳查询）只有画布遍：33 MP 时 3.6–4.0 ms，23 MP 时 2.7 ms，14.7 MP 时 1.6–2.6 ms。其余都在浏览器一侧。

## 与页面内容的关系

每个显示帧改一次左上角的小方块来驱动绘制，统计 3 秒内 `paint` 的平均间隔（`tools/ticker.js`）。2560 × 1440 CSS 像素：

| 页面内容 | @2（14.7 MP） | @3（33 MP） |
| --- | --- | --- |
| 完整页面 | 17.3 ms | 47.1 ms |
| 隐藏视频与图片 | 18.8 ms | 43.8 ms |
| 隐藏全部内容，只剩根元素背景 | 16.7 ms | 32.9 ms |

空白页在 33 MP 时仍然要 33 ms。按这台机器粗算，这条路径每帧每百万像素约 1 ms，页面内容再往上加。所以高分辨率下的瓶颈主要是按像素计费的新建表面、光栅化、拷贝与合成，不是页面写得太重。

## 评估过、没有采用的办法

| 办法 | 能省多少 | 为什么不做 |
| --- | --- | --- |
| 把整页直接写进画布纹理，省掉画布遍那次整页拷贝 | 最多是画布遍的 3.6–4 ms（33 MP 的一成） | 玻璃的模糊与折射需要一份背景。顶栏一直带模糊，要拷的背景范围接近整页宽、上下各留几倍 σ，实际只能省下一部分；还要改动背景合成、内容遮挡、低分辨率合成的顺序。收益不足以抵消风险，先不做。 |
| 页面没变的帧沿用上一帧快照 | 整条浏览器路径 | 只在玻璃自己动画（弹簧、液体迁移）时成立；画布像素数成为瓶颈的场景是滚动，每帧页面都在变。 |
| 降低快照频率或隔帧更新玻璃 | 最多一半 | 滚动时文字和玻璃里的背景会跟不上，比掉帧更难看。 |
| 降低画布倍率 | 与像素数成正比 | 文字变软，影响全屏所有元素的阅读，按要求作为底线不再自动使用。 |

降低这部分开销需要浏览器一侧的改进，例如 `drawElementImageToTexture()` 复用光栅化目标、只重新光栅化变化的区域。

## 改为缺省后的滚动开销

`hybrid`（缺省，带折射场缓存）与 `profile` 对照，八秒往返滚动两轮：

| 场景 | 光路 | 绘制间隔（均值 / P95） | 每帧 GPU（均值） | 结束时 |
| --- | --- | --- | --- | --- |
| 桌面 1563 × 1013 @2 | `hybrid` | 16.7 / 17.0–17.1 ms | 3.5 ms | |
| 5K 2560 × 1440 @2，自适应关闭 | `profile` | 18.6–19.3 / 21.8–23.8 ms | 9.6–10.1 ms | |
| 同上 | `hybrid` | 18.2–18.4 / 21.0–22.1 ms | 9.2–9.3 ms | |
| 同上，自适应开启（缺省） | `hybrid` | 18.0–18.1 / 20.6–21.0 ms | 10.4–10.9 ms | 光路 `hybrid`、玻璃倍率 2、画布倍率不变 |

5K @2 的瓶颈同样是浏览器路径：自适应试过光路与玻璃倍率都不见效，撤回后保持原样。

## 复测

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/perf --emptyOutDir
cp /tmp/perf/tests/perf/scroll.html /tmp/perf/index.html
pnpm exec vite preview --outDir /tmp/perf --port 4399
```

```sh
CDP_PORT=9377 W=2560 H=1440 DPR=3 node docs/performance/2026-11-16-text-floor/tools/trace.mjs "http://localhost:4399/?gpu&adaptive=0&glass=0" trace.json
python3 docs/performance/2026-11-16-text-floor/tools/tsum.py trace.json
python3 docs/performance/2026-11-16-text-floor/tools/tgpu.py trace.json
```

滚动与 GPU 时间用 [`2026-11-13-fill-rate/tools/gpu.mjs`](../2026-11-13-fill-rate/tools/gpu.mjs)（`CDP_PORT=9377 W=2560 H=1440 DPR=2 node gpu.mjs "http://localhost:4399/?gpu&adaptive=0&optics=hybrid" 2`）。
