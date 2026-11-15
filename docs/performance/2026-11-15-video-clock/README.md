# 视频按视频帧重绘

2026-11-15，Chrome 157.0.8103.39，Apple M1（Metal 3）。生产构建（基线 `52d3c69`），`tests/perf/scroll.html`，视口 1563 × 1013 @2，演示首页的视频是 30 帧。GPU 时间是整帧跨度。**没有在真机上测量**，也没有测量耗电。

同一台机器上还有别的会话在用 GPU 测量，本文的数字都是在独占 GPU 时取的（测量前 `ioreg` 显示的 GPU 利用率为 0%）；并发时每帧 GPU 时间会高出三四倍，绘制间隔也会变长，那些轮次已丢弃。

## 做了什么

- **视频时钟**（`src/video-clock.ts`）：原来有视频在播放时用 `requestAnimationFrame` 每个显示帧请求重绘，现在对每个正在播放的视频登记 `requestVideoFrameCallback()`，有新的视频帧才请求重绘。浏览器没有这个接口时退回原来的做法。
- **显示帧探针**（`src/frame-probe.hot.ts`）：每次绘制之后用 `requestAnimationFrame` 数最多两个显示帧，据此知道下一次绘制是不是紧接着上一个显示帧。
- **自适应降级**只对连续的绘制取样：中间空过显示帧的绘制不计入窗口，既不降级也不升回。

## 结果

停在页面顶部、只有视频在播放，八秒（`hold.mjs`，`VIDEO=1`、`?hold=0`），各两到三轮：

| | 绘制次数 | 绘制间隔（均值 / P95） | 每帧 GPU（均值 / P95） | 每次绘制的 CPU | 结束时的玻璃倍率与光路 |
| --- | --- | --- | --- | --- | --- |
| 改动前，`adaptive=0` | 478–479 | 16.7 / 17.2 ms | 2.29–2.33 / 2.6 ms | 1.9 ms | 2，`profile` |
| 改动后，`adaptive=0` | 240–241 | 33.4 / 35.5 ms | 2.77–2.87 / 3.3 ms | 3.5 ms | 2，`profile` |
| 改动前，自适应开启 | 478–479 | 16.7 / 17.2 ms | 2.31 / 2.6 ms | 1.9 ms | 2，`profile` |
| 改动后，自适应开启 | 240–241 | 33.4 / 35.5 ms | 2.78–2.85 / 3.3 ms | 3.5 ms | 2，`profile` |
| 只换视频时钟、自适应不改（对照） | 240–241 | 33.4 / 35.5 ms | 2.63–2.74 / 3.1 ms | 3.5 ms | **1**，`profile` |
| 改动前，自适应开启，`optics=hybrid` | 478–479 | 16.7 / 17.2 ms | 2.49 / 2.8 ms | 1.9 ms | 2，`hybrid` |
| 改动后，自适应开启，`optics=hybrid` | 239–241 | 33.4 / 50 ms | 3.04–3.07 / 3.6 ms | 3.4 ms | 2，`hybrid` |
| 对照，`optics=hybrid` | 238–240 | 33.6 / 51 ms | 2.66–2.71 / 3.1 ms | 3.4 ms | **1**，**`profile`** |

- 绘制次数减半。八秒里 GPU 时间合计从约 1100 ms 降到约 680 ms（`profile`，减少 39%），`hybrid` 从约 1190 ms 降到约 730 ms。
- 省下的没有到一半：每帧 GPU 时间从 2.3 ms 升到 2.8 ms。改动前的每帧时间并不是两个峰（P50 2.29、P95 2.62），所以不是“重复的帧本来就便宜”；推测是负载减半后 GPU 降频，**没有验证**。
- 主线程几乎没有省：每次绘制的 CPU 时间从 1.9 ms 升到 3.5 ms，合计 0.92 s → 0.83 s。按均值推算，原来重复画同一帧视频的那一半绘制每次只有约 0.4 ms（页面快照没有变化），贵的是带着新视频帧的那一半。`frames.mjs` 量到的渲染进程主线程任务时间也印证这一点（下表）。
- 对照组说明了问题本身：视频时钟换成视频帧节拍后，自适应把 33 ms 的间隔当成掉帧，玻璃倍率从 2 降到 1，`hybrid` 还被降为 `profile`，而且之后一直是这个节拍，升不回来。加上探针后倍率与光路都不变。

不点测量按钮（页面上没有测量用的逐帧循环），视频播放四秒（`frames.mjs`，各三轮）：

| | `paint` 事件 | 视频帧回调 | 回调与绘制在同一显示帧 | `requestAnimationFrame` 回调 | 主线程任务时间 | 暂停后两秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 改动前 | 240–241 | 119–120 | 全部 | 240–241 | 607–622 ms | 没有绘制与回调 |
| 改动后 | 120 | 120 | 全部 | 238–240（探针） | 607–642 ms | 没有绘制与回调 |
| 改动后，`adaptive=0` | 120 | 120 | 全部 | 0 | 583–656 ms | 没有绘制与回调 |

- 每个视频帧恰好对应一次绘制，没有漏掉的视频帧（`presentedFrames` 的增量都是 1）。
- 探针让主线程仍然每个显示帧醒一次，但这些空的帧量不出开销（与 `adaptive=0` 时没有区别）。

滚动中播放视频（`gpu.mjs … 2 video`），各两轮：

| | 绘制次数 | 绘制间隔（均值 / P95） | 每帧 GPU | 结束时的玻璃倍率 |
| --- | --- | --- | --- | --- |
| 改动前，`adaptive=0` / 自适应开启 | 481 / 481 | 16.7 / 17.0 ms | 2.60 / 2.60 ms | 2 / 2 |
| 改动后，`adaptive=0` / 自适应开启 | 480–481 / 481 | 16.7 / 17.1 ms | 2.60–2.63 / 2.59 ms | 2 / 2 |

真的跟不上时自适应仍然降级。2560 × 1440 @3（3300 万像素，浏览器把整页画进画布就要 33 ms）、`optics=hybrid`、自适应开启：

| | 绘制间隔 | 结束时的玻璃倍率与光路 |
| --- | --- | --- |
| 滚动中播放视频，改动前 / 改动后 | 32.7–33.0 / 32.8 ms | 1.5，`profile` / 1.5，`profile` |
| 停在顶部播放视频，改动前 / 改动后 | 35.9 / 36.4 ms | 1.5，`profile` / 2.25，`profile` |

停在顶部那一行里浏览器每 36 ms 才出一帧，每一帧都在绘制，探针判定为连续，于是开始降级；降了两级之后两次绘制之间出现了空的显示帧，就停在那里。这个场景的瓶颈不在玻璃，降不降级绘制间隔都是 36 ms。

## 画面同步

回调、`requestAnimationFrame`、`paint` 依次发生在同一个显示帧里（回调到绘制相隔几毫秒），页面快照取的就是刚到的那一帧视频；玻璃里的折射与模糊取自同一张快照，播放中不会比视频慢一拍。这一点来自代码结构，没有逐帧录屏比对。

能直接验证的是停住之后：`sync.mjs` 先截下停住后留在屏幕上的画面，再强制舞台重绘一次截第二张。暂停三次（时刻相对视频帧是随机的）、暂停状态下跳转两次、循环回绕后暂停一次，3126 × 2026：

| 画面 | 留在屏幕上的 vs 强制重绘后 | 强制重绘两次之间 |
| --- | --- | --- |
| 暂停 2、暂停 3、跳转到 1 秒、跳转到 4.2 秒、循环回绕 | 0 个像素不同 | 0 |
| 暂停 1 | 1 个像素差 1 级（改动前是 2 个像素） | 0 |

各个画面之间相差 310–340 万个像素，说明每次停住后画面确实换成了新的一帧。

## 为什么用探针，而不是视频帧的元数据

动手前在 Chrome 157 里探测到的（临时脚本，没有放进仓库）：

- 屏蔽 `requestPaint()`、也不登记视频帧回调，浏览器自己就会在每个新视频帧触发 `paint`（三秒 89 次），`changedElements` 里是根元素。也就是说 Chrome 157 里视频时钟只是保险；同时这种绘制和 DOM 变化引起的绘制在事件上没有区别。
- 所以“谁请求了重绘”分辨不了：一个逐帧的 CSS 动画加一个 30 帧的视频，跟不上时每次绘制都恰好赶上一个视频帧，`presentedFrames` 的增量也都是 1，和只有视频在动时观察到的完全一样。
- 能分辨这两者的是两次绘制之间有没有一个**没有绘制的显示帧**：有，说明那一帧本来就没有东西要画；没有，说明每一帧都在画，间隔就是浏览器出帧的速度。这个判断不依赖重绘是谁请求的，对间歇更新 DOM 的页面同样成立（原来每 33 ms 更新一次文字的页面也会被当成掉帧）。
- 视频帧回调的间隔本身有抖动（16.8–50 ms），偶尔连着两个显示帧各有一个新视频帧；这样的间隔是真实的连续绘制，照常取样。
- 视频滚出视口后回调停止（三秒 0 次），原来的时钟这时仍在每帧重绘。
- 播放中的视频移出文档后，浏览器在元素上触发 `pause`（不经过根元素），回调随之停止；循环回绕时触发 `seeked` 与 `playing`，没有 `pause`。

## 没有验证的部分与已知取舍

- **没有 `requestVideoFrameCallback` 的浏览器**：回退路径只有单元测试。目前支持 HTML-in-Canvas 的浏览器都有这个接口。
- **真机、120 Hz 屏幕、耗电**：都没有测。探针与刷新率无关，但自适应的阈值（19.5 ms / 17.5 ms）仍按 60 Hz 取。
- **60 帧、24 帧的视频与多个视频同时播放**：演示页只有一个 30 帧的视频，这些只有单元测试。60 帧的视频每个显示帧都有新画面，预期与改动前相同。
- **播放中的逐帧同步**没有录屏比对，见上。
- **取舍：只有视频在驱动重绘时不升回**。按视频帧节拍的绘制说明不了能否跟上显示器，所以这期间质量保持不变；滚动时降了级，停下来只剩视频时不会像原来那样四秒后试着升回，要等下一段连续的绘制（滚动、动画）流畅约四秒。静止的页面原本就是这样。如果希望静止时也试探升回，需要另加“升回后第一段连续绘制变慢就撤回并加倍等待”的逻辑。
- 探针在自适应开启时让主线程每个显示帧醒一次（绘制停止两帧后停下）。量不出开销，但如果要在只有视频播放时让主线程也按视频帧醒来，可以让探针隔几次绘制才数一次。

## 复测

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-video-build --emptyOutDir
cp /tmp/liquid-video-build/tests/perf/scroll.html /tmp/liquid-video-build/index.html
pnpm exec vite preview --outDir /tmp/liquid-video-build --host 127.0.0.1 --port 4232
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/liquid-chrome-video --remote-debugging-port=9391 --no-first-run --window-size=1563,1100 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required
```

```sh
CDP_PORT=9391 VIDEO=1 DPR=2 node docs/performance/2026-11-14-hybrid-optics/tools/hold.mjs "http://127.0.0.1:4232/?gpu&adaptive=0&hold=0" 2
CDP_PORT=9391 VIDEO=1 DPR=2 node docs/performance/2026-11-14-hybrid-optics/tools/hold.mjs "http://127.0.0.1:4232/?gpu&hold=0&optics=hybrid" 3
CDP_PORT=9391 DPR=2 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4232/?gpu" 2 video
CDP_PORT=9391 DPR=3 W=2560 H=1440 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4232/?gpu&maxPixelRatio=3&maxGlassPixelRatio=3&optics=hybrid" 2 video
CDP_PORT=9391 node docs/performance/2026-11-15-video-clock/tools/frames.mjs "http://127.0.0.1:4232/?" 3
CDP_PORT=9391 node docs/performance/2026-11-15-video-clock/tools/sync.mjs "http://127.0.0.1:4232/?adaptive=0" /tmp/sync
python3 docs/performance/2026-11-13-webgpu/tools/diff.py /tmp/sync/shown /tmp/sync/redrawn 0
```

- `hold.mjs` 与 `gpu.mjs` 的输出多了结束时的 `glassDpr` 与 `optics`。自适应的状态在同一个页面的各轮之间延续，第一轮（预热）不计入输出。
- `frames.mjs`：不启动测量页的逐帧循环，统计 `paint`、视频帧回调、`requestAnimationFrame` 回调与主线程任务时间。
- `sync.mjs`：停住后的画面与强制重绘后的画面，配合 `diff.py` 逐像素比较。
- 对照组是把 `CanvasStage.draw()` 里的 `this.frameProbe.mark()` 去掉后的临时构建。
- 测量期间不要让别的页面占用 GPU：`ioreg -r -d 1 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*'` 应接近 0。
