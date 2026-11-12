# STILL · Liquid Glass in Canvas

一个使用 **HTML-in-Canvas + three.js WebGPU** 实现液态玻璃的交互商店。页面与控件都是可点击、可聚焦的实时 HTML。浏览器把页面与玻璃控件分别上传为纹理，再合成到同一张画布。

视觉依据包括 Apple 的 Liquid Glass 演示，以及 iOS 26 用户指南中的照片和 Safari 实际 UI。参考截图、观察结果和实现范围见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

## 运行

本地开发需要 Node.js `>=20.19`，包管理器使用项目指定的 pnpm `12.9.1`。

需要支持 HTML-in-Canvas、WebGPU 和 `GPUQueue.drawElementImageToTexture()` 的浏览器。启动时逐项检查能力；缺少能力时显示说明页。项目开发检查使用 Chrome 157 对应的 API，不提供 CSS 玻璃替代版。

```sh
pnpm install
pnpm dev
```

打开终端显示的本地地址，默认是 http://localhost:5173。

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

## 体验

- 首页可切换花间、器物和光影三种背景。视频可以暂停，离开可见区域时也会暂停。
- 右上角外观按钮展开为材质设置，可以对比通透和柔和两种效果。
- 按住玻璃控件可看到轻微形变。菜单、场景选择和商品筛选使用阻尼弹簧。
- 顶栏、主物信息牌、商品加入按钮与媒体控件使用三维玻璃。同层控件靠近时可融合。
- 支持中英文、深浅主题、商品详情、分类、购物袋持久化与演示结算。不会创建真实订单。
- 跟随系统的减少动态效果、减少透明度和增强对比度设置。菜单支持 Escape，购物袋支持键盘焦点循环。

右下角的客服按钮可拖动。点击展开磨砂玻璃对话框，拖到其他玻璃附近可观察融合与遮挡。聊天仅提供本地演示回复。

## 添加玻璃控件

在 HTML 元素上添加 `data-liquid-glass`。它的定位父元素应当是没有 `drawable` 属性的普通元素。

```html
<div class="positioning-parent" style="position: relative">
  <button
    data-liquid-glass
    data-glass-radius="999"
    data-glass-variant="regular"
    data-glass-refraction="12"
    data-glass-blur="20"
  >
    浏览系列
  </button>
</div>
```

| 属性 | 含义 |
| --- | --- |
| `data-glass-layer` | 玻璃层级，默认 0，值越大越靠前。同层玻璃可以融合 |
| `data-glass-fusion` | 融合距离，默认 32 CSS 像素，0 表示关闭 |
| `data-glass-elevation` | 玻璃底面到背景的距离，默认 16 CSS 像素 |
| `data-glass-radius` | 圆角，支持 CSS 顺序的一至四个值，单位为 CSS 像素 |
| `data-glass-variant` | `regular` 或 `clear` |
| `data-glass-blur` | 目标高斯标准差，0–80 CSS 像素；相邻模糊层间近似插值 |
| `data-glass-refraction` | 三维实体的半厚度参考值，0–80，实际厚度受控件短边限制 |
| `data-glass-dispersion` | RGB 采样分离强度，0–1 |
| `data-glass-tint` | 十六进制染色值 |
| `data-glass-tint-alpha` | 染色比例，0–1 |
| `data-glass-specular` | 轮廓高光强度，0–2 |
| `data-glass-shadow` | 外侧阴影强度，0–1 |
| `data-glass-shadow-size` | 阴影范围，0–100 CSS 像素 |
| `data-glass-anchor` | 用于定位的祖先选择器，缺省使用 offsetParent |

在需要裁剪的普通祖先上添加 `data-glass-clip`。玻璃和阴影会限制在该祖先的矩形内，适合媒体视图。

模态层的根节点使用 `data-glass-modal`，其中的遮罩使用 `data-glass-scrim`。打开时，模态层外的玻璃按遮罩透明度压暗。页面切换容器使用 `data-glass-fade`，其透明度会作用到内部玻璃。

玻璃元素的背景应当透明。背景色会进入内容纹理并遮住透镜。`drawable` 元素自身的 CSS transform 在目标浏览器中可能产生空快照，因此菜单动画使用布局尺寸，按压形变由材质完成。

## 渲染结构

分层、帧流水线、DOM 约定与绘制顺序见 [架构](docs/ARCHITECTURE.md)。

- `src/stage/CanvasStage.ts`：页面上传、绘制、尺寸变化和视频时钟。
- `src/stage/contract.ts`：页面与舞台之间的 DOM 约定。舞台不依赖组件类名或 ID。
- `src/stage/render-order.ts`：页面、各层玻璃与前景的绘制顺序。
- `src/stage/liquid-glass/`：三维距离场、同层融合、HTML 内容遮挡、多级高斯模糊与按压反馈。
- `src/stage/CanvasOverlay.ts`：将商品共享动画画在导航玻璃上方。
- `src/shared/`：弹簧、偏好存储和减少动态效果查询。
- `src/components/home/GlassShowcase.vue`：媒体场景、材质选择与播放控制。

控件内容单独上传。发生重叠时，按玻璃层级、HTML 层叠上下文与 DOM 顺序判断前后关系。下层内容被覆盖的部分加入背景卷积，上层文字保持清晰。商品共享动画有独立透明前景层，购物袋在其上方。

## 已知问题

- 页面滚动存在掉帧。内容排序的 CPU 开销已有测量结果，但尚未确认帧间隔改善，见[性能记录](docs/performance/2026-11-07/README.md)。
- 暂停视频后滚动，部分玻璃上的文字可能缺失。该问题已在本地调查中复现，尚未解决。
- 打开购物袋后，其他玻璃效果异常和内容偶发消失的问题已有用户反馈，原因尚待定位。

## 范围与来源

这是对 Apple 视觉行为的 Web 近似实现，不是 Apple 原生材质。同层融合使用三维平滑距离场近似表面张力。背景语义适配、设备姿态光照和不同玻璃层间的递归折射尚未实现。详细限制见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

[liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio) 提供了折射、色散、SDF 和多遍模糊的研究参考。花朵视频使用该项目引用的 Pixabay / Pexels 素材，商品图保存在 `public/products/`。Apple 参考截图只在研究文档中引用，不作为商店素材。
