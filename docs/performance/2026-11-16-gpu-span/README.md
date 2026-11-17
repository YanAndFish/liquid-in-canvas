# 自适应降级用整帧 GPU 跨度排除无望的手段

2026-11-16，Chrome 157.0.8103.39，Apple M1（Metal 3）。生产构建，`tests/perf/scroll.html` 暂停视频、八秒往返滚动 2200 像素，自适应开启。高分辨率视口用 CDP 模拟，GPU 是同一台机器的，**没有在真机上测量**。测量期间同一台机器上另开着一个日常使用的 Chrome，33 MP 关闭判据时的间隔（36.7–42.7 ms）比 [text-floor](../2026-11-16-text-floor/README.md) 的 33–35 ms 慢，两种配置在同一时段交替测量，可以互相比较。原始数据见 `runs.jsonl`。

## 做了什么

- **整帧跨度**（`gpu-span.hot.ts`）：自适应开启、设备支持 `timestamp-query` 时，每 4 帧采一次。第一遍写开始与结束时间戳，其余各遍只改写结束，读回的是“第一遍开始 → 最后一遍结束”。上一次读回完成之前不再采样；测量页打开逐遍计时（`?gpu`）时让给它。每次采样只分配 `mapAsync` 的 Promise，时间戳按两个 `Uint32` 换算，不经过 BigInt。
- **判据**（`AdaptiveScale.next()`）：窗口结束时取窗口内最小的跨度 S。要降一级时，回到 60 帧需要省下“基准间隔 − 17.5 ms”；光路与玻璃着色倍率只影响舞台自己的遍，省下的不会超过 S，需要省的超过 S 时跳过这两种手段，只考虑画布倍率（没有打开时什么都不改）。没有样本时 S 为无穷大，与原来一致。
- 判据只用来排除手段：S 够大不代表降下来就见效，确认仍交给原有的检验。
- 测量页：结果多了 `span`（本轮跨度样本的分布、最小值、最近一个窗口的 S、被判据跳过的次数），`?spanBound=0` 关闭判据。

## 结果

### 2560 × 1440 @3（33 MP），`hybrid`，缺省（画布倍率一级关闭）

| 判据 | 绘制间隔均值（第 2–5 轮） | 结束时 | 自加载起的变化 |
| --- | --- | --- | --- |
| 关闭 | 36.7–37.7 ms | 光路 `profile`，玻璃 1.5 | 6.7 秒光路改 `profile` 并保留；9.2 秒玻璃 1.5，10.6 秒撤回；42.7 秒再试玻璃 1.5、1.125，46.4 秒停在 1.5 |
| 打开 | 36.9–37.3 ms | 光路 `hybrid`，玻璃 2 | 没有变化，判据跳过 44 次 |

- 间隔相同，打开判据后画质不再被降低。关闭时光路与玻璃的降级被检验判为见效，但间隔没有变短。
- 跨度：每轮最小值 8.7–9.3 ms，中位数 9.9–12.5 ms，P95 11.9–33.2 ms。P95 被排队拉长，最小值很稳，取最小值是对的。需要省下约 19.5 ms，远超 S。
- 带玻璃时舞台自己的跨度约 9 ms；text-floor 记录的 3.6–4 ms 是不画玻璃（`?glass=0`）时的数字。

### 同上，`minPixelRatio=1`（打开画布倍率一级）

| 判据 | 第一次降画布倍率 | 之前的尝试 | 最终几轮 |
| --- | --- | --- | --- |
| 关闭 | 10.1 秒 | 光路、玻璃 1.5、1.125 各试一次 | 画布 1.85–2.14，16.7–17.5 ms |
| 打开 | 4.4 秒（3 → 2.12） | 没有 | 画布 1.84–2.12，17.3–17.6 ms |

- 打开后第一次变慢就直接降画布倍率，少了约 5.7 秒的无效尝试。画布降到 2.12 之后需要省的只有一两毫秒，判据放行，光路与玻璃照常尝试，与关闭时一样。

### 玻璃是瓶颈：5K 2560 × 1440 @2

| 光路 | 判据 | 变化 | 跳过次数 |
| --- | --- | --- | --- |
| `hybrid` | 打开 | 13.2 秒光路改 `profile` | 0 |
| `raymarch` | 关闭 | 11.0 秒 `profile`，20.9 秒升回，25.1 秒再降 | 0 |
| `raymarch` | 打开 | 7.1 秒 `profile`，20.9 秒升回，25.1 秒再降 | 0 |

- 需要省的只有一到三毫秒，S 为 4.5–4.8 ms，判据从不触发，行为与原来相同。

### 桌面 1563 × 1013 @2，`hybrid`

16.7 ms，没有变化。每 4 帧一个样本（8 秒 120 个），跨度中位数 2.8 ms、均值 3.4 ms，与 text-floor 里逐遍计时测到的整帧 3.5 ms 一致。

## 没有验证的

- 全部是 CDP 模拟视口和同一台 M1。手机与其他 GPU 上 `timestamp-query` 是否可用、量化粒度多大，没有确认；不可用时自动退回原来的行为。
- 窗口最小值反映的是窗口里最便宜的一帧。窗口内场景变化很大（滚过一段贵的玻璃）时 S 会偏小，可能把其实有用的手段排除。这里的场景需要省的时间远大于 S，没有碰到；按每轮跨度的中位数估算，上面几组数据的结论不变，但中位数对排队拉长更敏感，还没有专门测试。
- 没有单独测量采样本身的开销。桌面 @2 的绘制间隔与每帧 GPU 时间与之前的记录一致。
- 间隔落在两个刷新周期之间时（例如 37 ms），只省一部分也会改变 33 / 50 ms 帧的比例；判据要求一次就能回到 60 帧，会放过这种部分收益。上面 33 MP 的数据里，关闭判据时的部分降级没有带来可见的改善。

## 复测

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/liquid-chrome-span --remote-debugging-port=9433 --no-first-run --window-size=1563,1100 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
```

```sh
cd apps/demo
pnpm exec vite build --config tests/perf/vite.config.ts --outDir /tmp/liquid-span --emptyOutDir
cp /tmp/liquid-span/tests/perf/scroll.html /tmp/liquid-span/index.html
pnpm exec vite preview --outDir /tmp/liquid-span --host 127.0.0.1 --port 4421
```

```sh
CDP_PORT=9433 W=2560 H=1440 DPR=3 node docs/performance/2026-11-16-gpu-span/tools/adapt-span.mjs "http://127.0.0.1:4421/?spanBound=0" 5
CDP_PORT=9433 W=2560 H=1440 DPR=3 node docs/performance/2026-11-16-gpu-span/tools/adapt-span.mjs "http://127.0.0.1:4421/" 5
CDP_PORT=9433 W=2560 H=1440 DPR=3 node docs/performance/2026-11-16-gpu-span/tools/adapt-span.mjs "http://127.0.0.1:4421/?minPixelRatio=1" 3
CDP_PORT=9433 W=2560 H=1440 DPR=2 node docs/performance/2026-11-16-gpu-span/tools/adapt-span.mjs "http://127.0.0.1:4421/?optics=raymarch" 3
```

`tools/adapt-span.mjs` 是 [adaptive-canvas 的 `adapt.mjs`](../2026-11-15-adaptive-canvas/tools/adapt.mjs) 加上 `span` 字段。
