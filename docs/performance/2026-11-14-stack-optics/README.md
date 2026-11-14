# 剖面光学、多层玻璃与新剖面的开销

2026-11-14，Chrome 157.0.8103.39，Apple Metal 3。工作区改动的生产构建（基线 `046f703`），`tests/perf/scroll.html` 暂停视频、八秒往返滚动 2200 像素，`?gpu&adaptive=0`。手机视口用 CDP 模拟，GPU 是同一台桌面机器的，**没有在真机上测量**。GPU 时间是整帧跨度（见 [2026-11-13-webgpu](../2026-11-13-webgpu/README.md#gpu-时间戳)）。

## 结论

| 场景 | `optics=raymarch` | `optics=profile` |
| --- | --- | --- |
| 桌面 1563 × 1013 @2，每帧 GPU 时间（均值，两组各两轮） | 7.0–8.5 ms | 2.4–2.8 ms |
| 同上，P95 | 14.9–17.5 ms | 3.2–3.9 ms |
| 同上，绘制间隔均值 | 17.0–17.7 ms | 16.7 ms |
| 手机 412 × 915 @3（画布与玻璃都是 3 倍），每帧 GPU 时间 | 6.8 ms（P95 13.0） | 1.9 ms（P95 2.2） |
| 桌面 @2，调参面板展开（第 1 层盖住顶栏，产生一级上层背景） | 17.6 ms，绘制间隔 18.8 ms | 3.5 ms，绘制间隔 16.7 ms |

- 剖面光学每帧 GPU 时间约为三维求交的三分之一，各场景都保持 60 帧。
- 新的折射剖面（半厚度为短边 0.3 倍、上限 80）让玻璃变厚、倒角变宽，三维求交要走的步数随之增加：桌面 @2 从上一份记录的约 4.7 ms 升到 7–8.5 ms，调参面板展开时降到约 53 帧。因此缺省改为剖面光学，三维求交保留为 `optics: 'raymarch'`。
- 多层玻璃的额外开销只在交叠时出现：上层背景在 CSS 分辨率下只覆盖取样范围加模糊余量，模糊同样只卷积这部分。

画布渲染器分块从 66 kB 增至 98 kB（未压缩），来自剖面着色器、查找表追踪与上层背景。

## 画面

- 剖面光学与三维求交在 `tests/visual/liquid-glass.html` 上对比：3.84M 像素中相差超过 2 级的有 5258 个、最大 52 级，全部在方形与圆形融合的连接处；单块玻璃没有可见差异。
- 新剖面用 `docs/performance/2026-11-14-visual/tools/profile_fit.py` 在两色胶囊上测量：倒角宽度 1 倍时弯折带为短边的 18.9%、`d = 0.088` 处位移 0.135（参考截图约 0.14）；最终取 0.45 倍，使圆形玻璃靠边的暗区不被整片翻成亮色，弯折带约为短边的 13.5%（0.3 × 0.45）。

## 复测

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-stack-build --emptyOutDir
cp /tmp/liquid-stack-build/tests/perf/scroll.html /tmp/liquid-stack-build/index.html
pnpm exec vite preview --outDir /tmp/liquid-stack-build --host 127.0.0.1 --port 4190
```

```sh
CDP_PORT=9334 DPR=2 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4190/?gpu&adaptive=0&optics=profile" 2
CDP_PORT=9334 DPR=3 W=412 H=915 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4190/?gpu&adaptive=0&maxPixelRatio=3&maxGlassPixelRatio=3&optics=raymarch" 1
CDP_PORT=9334 OPEN_PANEL=1 DPR=2 node docs/performance/2026-11-13-fill-rate/tools/gpu.mjs "http://127.0.0.1:4190/?gpu&adaptive=0&optics=raymarch" 1
```
