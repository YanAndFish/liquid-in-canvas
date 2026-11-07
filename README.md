# STILL · Liquid Glass in Canvas

一个使用 **HTML-in-Canvas + three.js WebGPU** 实现液态玻璃的交互商店。页面与控件都是可点击、可聚焦的实时 HTML。浏览器把页面与玻璃控件分别上传为纹理，再合成到同一张画布。

视觉依据包括 Apple 的 Liquid Glass 演示，以及 iOS 26 用户指南中的照片和 Safari 实际 UI。参考截图、观察结果和实现范围见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

## 运行

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
- 按住玻璃控件可看到局部亮光和轻微形变。菜单、场景选择和商品筛选使用阻尼弹簧。
- 导航与购物袋使用柔化的玻璃；商品图片和说明使用普通内容表面。
- 支持中英文、深浅主题、商品详情、分类、购物袋持久化与演示结算。不会创建真实订单。
- 跟随系统的减少动态效果、减少透明度和增强对比度设置。菜单支持 Escape，购物袋支持键盘焦点循环。

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
| `data-glass-radius` | 圆角，支持 CSS 顺序的一至四个值，单位为 CSS 像素 |
| `data-glass-variant` | `regular` 或 `clear` |
| `data-glass-blur` | 目标高斯标准差，0–80 CSS 像素；相邻模糊层间近似插值 |
| `data-glass-refraction` | 透镜厚度与位移参考值，0–80 |
| `data-glass-dispersion` | RGB 采样分离强度，0–1 |
| `data-glass-tint` | 十六进制染色值 |
| `data-glass-tint-alpha` | 染色比例，0–1 |
| `data-glass-specular` | 轮廓高光强度，0–2 |
| `data-glass-shadow` | 外侧阴影强度，0–1 |
| `data-glass-shadow-size` | 阴影范围，0–100 CSS 像素 |
| `data-glass-anchor` | 用于定位的祖先选择器，缺省使用 offsetParent |

在需要裁剪的普通祖先上添加 `data-glass-clip`。玻璃和阴影会限制在该祖先的矩形内，适合媒体视图。

玻璃元素的背景应当透明。背景色会进入内容纹理并遮住透镜。`drawable` 元素自身的 CSS transform 在目标浏览器中可能产生空快照，因此菜单动画使用布局尺寸，按压形变由材质完成。

## 渲染结构

- `src/stage/CanvasStage.ts`：页面上传、绘制、尺寸变化和视频时钟。
- `src/stage/liquid-glass/`：SDF 材质、多级高斯模糊、表面发现与指针响应。
- `src/stage/CanvasOverlay.ts`：将商品共享动画画在导航玻璃上方。
- `src/composables/useSpring.ts`：菜单与选择器的弹簧动画。
- `src/components/home/GlassShowcase.vue`：媒体场景、材质选择与播放控制。

玻璃从不含玻璃控件的页面快照取样。控件内容单独上传，文字保持清晰。商品共享动画有独立透明前景层，购物袋在其上方。

## 范围与来源

这是对 Apple 视觉行为的 Web 近似实现，不是 Apple 原生材质。完整的背景语义适配、设备姿态光照、跨控件融合和多层相互折射尚未实现。详细限制见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

[liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio) 提供了折射、色散、SDF 和多遍模糊的研究参考。花朵视频使用该项目引用的 Pixabay / Pexels 素材，商品图保存在 `public/products/`。Apple 参考截图只在研究文档中引用，不作为商店素材。
