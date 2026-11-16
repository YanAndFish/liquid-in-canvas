# 混合光路与降级方案的研究

2026-11-14，Chrome 157.0.8103.39，Apple M1（Metal 3），5K 外接屏。生产构建，`tests/perf/scroll.html` 暂停视频、八秒往返滚动 2200 像素，`?gpu&adaptive=0`。手机与 5K 视口用 CDP 模拟，GPU 是同一台机器的，**没有在真机上测量**。GPU 时间是整帧跨度，每项两轮。

## 做了什么

- 新光路 `optics: 'hybrid'`：只有一名成员的组用剖面管线；融合的组与被 `data-glass-clip` 切开的玻璃用混合着色器，逐像素在平顶捷径、查表、三维求交之间选择（判定见 [架构](../../ARCHITECTURE.md#光路三维求交剖面查表与逐像素混合)）。缺省仍是 `profile`。
- 查找表每行多一条纹素行，记录光线在玻璃内的最大横向位移，用来证明一个像素的光路碰不到其余成员与裁剪边。
- 自适应降级多了一级：光路不是 `profile` 时，先改用 `profile`，再降低玻璃着色倍率。
- 测量页：`?optics=hybrid`、`?hold=<px>`（停在一个位置测量）、`?glass=0`（去掉所有玻璃）；结果里带实际倍率与光路。

## 每帧 GPU 时间（毫秒，均值 / P95）

| 场景 | `raymarch` | `profile` | `hybrid` |
| --- | --- | --- | --- |
| 桌面 1563 × 1013 @2 滚动 | 6.2 / 9.6 | 2.6 / 3.2 | 3.9 / 7.7 |
| 手机 412 × 915 @3 滚动 | 6.6 / 10.3 | 1.9 / 2.2 | 4.5 / 9.8 |
| 桌面 @2，调参面板展开后滚动 | 11.2 / 19.3 | 3.5 / 4.5 | 5.7 / 10.0 |
| 5K 2560 × 1440 @2 滚动 | 11.7 / 23（绘制间隔 18.4 ms） | 5.5 / 12 | 7.3 / 18（17.0 ms） |
| 停在 600（顶栏与下方玻璃融合），视频播放 | 6.65 | 2.43 | 4.34 |
| 停在 330，每 0.6 秒切换场景标签（液体迁移） | 4.57 | 2.20 | 2.35 |
| 停在 1100，每 0.9 秒开合调参面板 | 9.5 / 11.8 | 3.3 / 4.3 | 5.3 / 7.3 |

滚动的各行里，除 5K 的 `raymarch` 与 `hybrid` 外绘制间隔都是 16.7 ms；开合面板那一行两次点击之间画面静止，绘制间隔不能说明帧率。重构前后 `raymarch`、`profile` 的时间与画面都没有变化（逐像素最大差值 0）。

- `hybrid` 介于两者之间，多出来的时间全部来自真正求交的像素。把求交分支换成查表后是 2.68 / 3.57 ms（桌面 / 面板），只比 `profile` 多 0.07 ms；求交代码留在着色器里但不执行时再多 0.05–0.1 ms。寄存器压力与分支可以忽略。
- 求交像素集中在“固定顶栏 + 滚到它下面的玻璃”：融合距离 32 时平滑合并的范围是 64 像素，再加光线的横向位移。按档位着色的截图里（设备像素，@2）：滚动 600 处求交 12.6 万、查表 16.1 万、平顶 13.5 万；面板展开时求交 5.1 万、查表 10.7 万、平顶约 55 万；多数位置没有融合，全部走剖面管线。手机上顶栏几乎整条落在连接带里，所以收益最小。

## 画面

`shots.mjs` 的画面，与 `raymarch` 相差超过 2 级的像素数（最大差）：

| 画面 | `profile` | `hybrid` |
| --- | --- | --- |
| 检查页缺省（方形与圆形融合），融合组内 | 110379（92） | 25（18） |
| 检查页重叠 60 像素，融合组内 | 188134（110） | 0（1） |
| 检查页通透加厚、色散 1，融合组内 | 115012（191） | 2087（113） |
| 商店滚动 600（整幅画面） | 86842（52） | 129（33） |
| 商店面板展开（整幅画面） | 5663（110） | 87（40） |
| 手机滚动 700（整幅画面） | 159008（46） | 182（28） |
| 检查页间距从 −80 到 48 逐步 8 像素（17 个位置），融合组内 | 53887–203917（89–115） | 0–36（1–51） |
| 检查页用 `data-glass-clip` 切开一块玻璃：切两侧、切上沿、切下沿 | 806 / 1121 / 1175（112） | 16 / 16 / 0（3） |

- 单块玻璃上 `hybrid` 与 `profile` 逐像素相同（最大差 0）。`hybrid` 剩下的差异就是单块玻璃上查表与求交本来的差异（小圆角拐角、轮廓一像素内）；“通透加厚”那一格的 2087 个像素都在离连接处远的查表区。
- 查表与求交的交界两侧相差不超过 2 级，没有看到接缝。
- 间距扫描里两块玻璃的相对位置每步移动 8 像素，交界随之移动，每个位置上 `hybrid` 都与 `raymarch` 一致，剩下的几十个像素在圆形玻璃离连接处远的轮廓上（查表区）。间距 56 时两块玻璃不再融合，`hybrid` 与 `profile` 相同。这是逐个静止位置的比较，没有录制运动过程逐帧比对。
- 整幅画面的几行包含画面里所有单块玻璃的差异；没有融合的画面上 `hybrid` 与 `profile` 的数字相同（例如滚动 900 都是 71 个）。
- Chrome 冷启动后的第一组截图里背景图片本身与之后的不同（整张图 1–16 级），比较前要先丢弃一组。

## 试过但没有采用

- **重叠平顶档**：两块玻璃的平顶叠在一起时只求入射点。输出与求交逐位相同，但商店页面里一个像素都用不上（只有检查页重叠场景的 6 千像素），已撤掉。
- **四点法线、非倒角处跳过 `pow`**：`raymarch` 6.2 → 6.5 ms，没有收益，画面还有最大 141 级的变化，已撤回。
- 结论：求交本身的微优化收益有限，连接带的大小由融合距离决定，不是判定保守造成的。

## 高分辨率下的基线

`?glass=0`，2560 × 1440 CSS 像素：

| 画布倍率（像素数） | 绘制间隔 | 我们的 GPU 遍 |
| --- | --- | --- |
| @2（14.7 MP） | 16.7 ms | 1.5 ms |
| @2.25（18.7 MP） | 17.6 ms | — |
| @2.5（23 MP） | 22.3 ms | 2.5 ms |
| @3（33 MP） | 33.1 ms | 3.9 ms |

不画玻璃时，超过约 18 MP 帧率就随像素数下降，33 MP 只有 30 帧；我们自己的遍只占 2–4 ms，瓶颈在浏览器把整页画进画布。这时现有的降级全部无效：33 MP、`hybrid`、自适应开启，光路降为 `profile`、玻璃倍率降到 1 之后绘制间隔仍是 33 ms。能起作用的只有画布像素数（`maxPixels` 现在缺省不限）。

## 降级方案的结论

按损失从小到大：

1. **光路降为查表**（已实现）：只有连接处变成近似，连接多的画面省 35–60%。
2. **降低玻璃着色倍率**（已有）：所有玻璃的轮廓变软。
3. **降低画布倍率**（未实现）：文字变软，但像素数是瓶颈时只有它有效。需要先判断降级是否见效：降一级后间隔没有改善就撤回并换下一种手段，否则会像上面那样白白降低玻璃质量。
4. **降低玻璃的更新频率**（不建议）：最多省下玻璃那部分（桌面 `profile` 2.6 ms 里的 1.75 ms），滚动时玻璃里的背景落后一帧；像素数是瓶颈时没有收益。

两个没有画面损失、值得单独做的方向（都只有估算，没有实现）：

- **连接处的折射场缓存 + 运动时查表**（已实现，见 [2026-11-15-field-cache](../2026-11-15-field-cache/README.md)）：缓存的应是求交得到的折射场（取样偏移、法线、有效度、混合权重），不是颜色，背景仍然每帧取样，视频不会卡。几何不变时（面板与入口按钮、停住的顶栏）`hybrid` 可降到接近 `profile`；成员相对运动的帧缓存必然失效，这些帧改用查表、停下后再求交一次。对 `profile` 本身没有意义：它已经是查表，缓存只会把运算换成更多的纹理读取。
- **视频按视频帧重绘**：现在视频播放时用 `requestAnimationFrame` 每个显示帧都重绘。实测 `requestVideoFrameCallback` 在画布子树里可用，30 帧的视频 3 秒回调 90 次（同期 181 个显示帧）。只有视频在动时整帧工作量可以减半。要一并解决的是自适应降级会把 33 ms 的间隔当成掉帧。已实现，见 [2026-11-15-video-clock](../2026-11-15-video-clock/README.md)。

缺省光路建议暂时保持 `profile`：`hybrid` 在这台机器上各场景都能 60 帧，但手机 @3 的 P95 已是 9.8 ms，真机上很可能要靠自动降级回到 `profile`，应先在真机上测量。

## 复测

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-hybrid-build --emptyOutDir
cp /tmp/liquid-hybrid-build/tests/perf/scroll.html /tmp/liquid-hybrid-build/index.html
pnpm exec vite preview --outDir /tmp/liquid-hybrid-build --host 127.0.0.1 --port 4197
```

```sh
CDP_PORT=9377 DPR=2 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&optics=hybrid" 2
CDP_PORT=9377 DPR=3 W=412 H=915 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&maxPixelRatio=3&maxGlassPixelRatio=3&optics=hybrid" 2
CDP_PORT=9377 OPEN_PANEL=1 DPR=2 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&optics=hybrid" 2
CDP_PORT=9377 VIDEO=1 DPR=2 node docs/performance/2026-11-14-hybrid-optics/tools/hold.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&optics=hybrid&hold=600" 2
CDP_PORT=9377 VIDEO=1 CLICK='.scene-controls button' CLICK_MS=600 DPR=2 node docs/performance/2026-11-14-hybrid-optics/tools/hold.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&optics=hybrid&hold=330" 2
CDP_PORT=9377 CLICK='.lg-tuner-launcher' CLICK_MS=900 DPR=2 node docs/performance/2026-11-14-hybrid-optics/tools/hold.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&optics=hybrid&hold=1100" 2
CDP_PORT=9377 DPR=3 W=2560 H=1440 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4197/?gpu&adaptive=0&glass=0&maxPixelRatio=2.5" 1
CDP_PORT=9377 QUERY="optics=hybrid" node docs/performance/2026-11-13-webgpu/tools/shots.mjs http://127.0.0.1:4197 /tmp/shots/hybrid
python3 docs/performance/2026-11-13-webgpu/tools/diff.py /tmp/shots/raymarch /tmp/shots/hybrid 2
CDP_PORT=9377 OPTICS=hybrid node docs/performance/2026-11-14-hybrid-optics/tools/sweep.mjs http://127.0.0.1:4197 /tmp/sweep/hybrid
python3 docs/performance/2026-11-14-hybrid-optics/tools/sweep_diff.py /tmp/sweep/raymarch /tmp/sweep/hybrid
```

- `hold.mjs`：停在一个滚动位置测量，`CLICK` 让液体迁移持续发生，`VIDEO=1` 播放视频保持重绘。
- `sweep.mjs` / `sweep_diff.py`：画面检查页的间距扫描与裁剪场景，按融合组与被裁剪玻璃的范围统计。
- 按档位着色的截图来自临时改动的着色器（各档直接输出纯色），没有放进仓库。
