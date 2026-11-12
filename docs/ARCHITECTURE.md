# 架构

项目分三层，依赖只向下：

```
src/pages, src/components   Vue 视图：只通过 DOM 属性声明在舞台中的角色
src/composables, src/stores 视图状态：主题、语言、弹簧、购物袋、共享动画
src/domain, src/i18n        纯业务逻辑：商品、金额、购物袋计算与持久化
src/stage                   渲染舞台：HTML-in-Canvas + WebGPU，不认识任何 Vue 组件
src/shared                  与框架无关的工具：弹簧、偏好存储、减少动态效果
```

`src/stage` 只依赖 `src/shared` 与 three.js。视图层只从 `src/stage` 引入 `contract.ts`。

## 启动

`main.ts` 先检测能力（`stage/support.ts`）。缺少能力、初始化失败或运行时出错都会卸载商店并显示 `UnsupportedView`。成功时把 `#app` 移入 `<canvas content="drawable">`，挂载 Vue 后调用 `CanvasStage.start()`。

## 帧流水线

浏览器的 `paint` 事件驱动一帧，舞台本身没有常驻循环。只有视频播放和按压弹簧运动时才逐帧请求重绘。

1. **页面快照**：`CanvasStage` 把整个 `#app` 上传为纹理，同时作为全屏背景和玻璃的折射源。
2. **玻璃表面**（`LiquidGlassLayer.sync`）：测量每块 `[data-liquid-glass]`，按需上传其 HTML 内容。
3. **内容遮挡**（`content-order.ts`、`ContentBackdrop`）：按层级、层叠上下文与 DOM 顺序排序；被上层玻璃覆盖的下层文字写回背景，参与模糊。
4. **多级模糊**（`blur.ts`）：对合成背景逐级做高斯卷积，σ 为 2/6/16/40/80 CSS 像素。
5. **三维体积**（`VolumeGroups`、`volume-shader.ts`）：同层邻近玻璃合成一个距离场，按 RGB 三条光路折射取样。
6. **前景**（`CanvasOverlay`）：共享商品动画层单独上传，画在导航玻璃之上。
7. three.js 合成到画布。

## 隐式组件

以下组件原先散落在实现细节中，现在各有单独的模块或约定。

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| DOM 约定 | `stage/contract.ts` | 视图与舞台之间的全部 ID 和属性 |
| 绘制顺序 | `stage/render-order.ts` | 页面、各层玻璃、前景的 renderOrder 区间 |
| 元素纹理 | `stage/gpu.ts` | HTML 快照纹理的创建、上传、释放；全屏三角形 |
| 快照调度 | `LiquidGlassLayer` 内 `dirty` / `settleFrames` / `paintPending` / `contentComplete` | 决定何时向浏览器请求新的绘制记录、何时上传 |
| 模态压暗 | `[data-glass-modal]` + `[data-glass-scrim]` | 模态层打开时压暗其外部玻璃的染色和高光 |
| 页面淡入淡出 | `[data-glass-fade]` | 页面切换时把容器 opacity 传给内部玻璃 |
| 按压形变 | `fusion.ts` `pressedBox` | 体积距离场与内容遮挡共用的按压轮廓 |
| 弹簧 | `shared/spring.ts` | 玻璃按压与 Vue 菜单动画共用的阻尼弹簧 |
| 偏好存储 | `shared/storage.ts` | 主题、语言、购物袋的本地存储，隐私模式下静默失败 |
| 减少动态效果 | `shared/motion.ts` | 系统设置查询，供舞台、弹簧、视频和共享动画使用 |
| 共享动画注册 | `composables/sharedTransition.ts` | 模块级单例，连接商品卡片、详情页和购物袋图标 |

## DOM 约定

舞台只通过以下钩子认识页面。修改时同步 `stage/contract.ts`。

| 钩子 | 声明者 | 舞台行为 |
| --- | --- | --- |
| `#stage-scroll` | `App.vue` | 唯一滚动容器；路由滚动恢复、购物袋滚动锁定 |
| `[data-liquid-glass]` + `data-glass-*` | 各玻璃控件 | 注册为玻璃表面，参数见 README |
| `[data-glass-clip]` | `GlassShowcase` | 限制后代玻璃与阴影的绘制范围 |
| `[data-glass-modal]` | `CartDrawer` 外壳 | 模态层根节点，内部玻璃不被压暗 |
| `[data-glass-scrim]` | `CartDrawer` 遮罩 | 背景色 alpha × 模态层 opacity 决定压暗强度 |
| `[data-glass-fade]` | `App.vue` 页面容器 | opacity 作用到内部玻璃 |
| `[data-stage-overlay]` | `SharedTransitionLayer` | 单独上传的透明前景层 |

视图之间还有两个约定，不经过舞台：`[data-product-image]`（共享动画的起点和终点）与 `[data-bag-target]`（加入购物袋动画的终点）。

## 绘制顺序

| renderOrder | 内容 |
| --- | --- |
| 0 | 页面快照 |
| 900 + 10·L … +0.5 | 第 L 层玻璃的体积组 |
| 900 + 10·L + 1 … +2 | 第 L 层玻璃上的 HTML 内容 |
| 950 | 共享商品动画前景 |

导航和页面玻璃使用第 0 层，购物袋使用第 10 层，所以商品动画位于两者之间。`tests/stage/render-order.test.ts` 检查这些区间不重叠。

## 测试与诊断

- `tests/**/*.test.ts`：Vitest + jsdom，覆盖领域逻辑、视图和不依赖 GPU 的舞台逻辑。
- `tests/visual/*.html`：在支持的浏览器中人工检查玻璃边缘与内容遮挡。
- `tests/perf/`：独立构建入口，通过替换 `CanvasStage.prototype.draw` 记录帧时间，结果保存在 `docs/performance/`。

## 相关文档

- [HTML-in-Canvas 实践记录](HTML_IN_CANVAS_NOTES.md)
- [液态玻璃设计与着色器](LIQUID_GLASS_NOTES.md)
- [Apple Liquid Glass 视觉依据](APPLE_LIQUID_GLASS_REFERENCE.md)
