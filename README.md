# STILL · Liquid Glass in Canvas

用 **HTML-in-Canvas + three.js WebGPU** 在 Web 上渲染 iOS 风格的液态玻璃。仓库包含可单独发布的渲染库 `liquid-in-canvas`，和一个用它搭建的交互商店作为演示。页面与控件都是可点击、可聚焦的实时 HTML；浏览器把页面与玻璃控件分别上传为纹理，再合成到同一张画布。

视觉依据包括 Apple 的 Liquid Glass 演示，以及 iOS 26 用户指南中的照片和 Safari 实际 UI。参考截图、观察结果和实现范围见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

## 仓库结构

```
packages/liquid-in-canvas   渲染库，可单独发布为 npm 包
apps/demo                   演示商店 STILL
docs                        设计记录、视觉依据与性能记录
```

在其他项目中使用液态玻璃，见[渲染库的 README](packages/liquid-in-canvas/README.md)：安装、`mountLiquidGlass()`、`data-glass-*` 属性、全局默认参数、分辨率与回退实现。

## 运行

本地开发需要 Node.js `>=20.19`，包管理器使用项目指定的 pnpm `12.9.1`。

```sh
pnpm install
pnpm dev
```

打开终端显示的本地地址，默认是 http://localhost:5173。演示商店直接引用库的源码，修改库后不需要先构建。

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

`pnpm build` 依次构建库（`packages/liquid-in-canvas/dist`）和演示商店。只构建库用 `pnpm build:lib`。发布使用 `pnpm publish`，它会把 `package.json` 中指向源码的 `exports` 换成 `publishConfig` 里指向 `dist` 的版本；`npm publish` 不做这一步。

完整效果需要支持 HTML-in-Canvas、WebGPU 和 `GPUQueue.drawElementImageToTexture()` 的浏览器，开发检查使用 Chrome 157 对应的 API。启动时逐项检查能力；缺少能力时显示说明页，页面上的按钮可以改用回退版本继续浏览：Chromium 内核使用带折射的 SVG 滤镜，其他浏览器使用纯 CSS。

## 体验

- 首页可切换花间、器物和光影三种背景。视频可以暂停，离开可见区域时也会暂停。
- 右上角外观按钮展开为材质设置，可以对比通透和柔和两种材质。
- 按住玻璃控件可看到轻微形变。菜单、场景选择和商品筛选使用阻尼弹簧。
- 顶栏、主物信息牌、商品加入按钮与媒体控件使用三维玻璃。同层控件靠近时可融合。
- 支持中英文、深浅主题、商品详情、分类、购物袋持久化与演示结算。不会创建真实订单。
- 跟随系统的减少动态效果、减少透明度和增强对比度设置。菜单支持 Escape，购物袋支持键盘焦点循环。

### 调参面板

右下角的圆形按钮可以拖动，点击展开调参面板：

- **渲染方式**：在画布、SVG 滤镜回退和纯 CSS 回退之间切换。浏览器不支持的方式不可选。
- **画布倍率上限**、**玻璃着色倍率上限**与**自动降低玻璃着色倍率**：只对画布有效，面板显示当前两个实际倍率。画布倍率决定文字清晰度，自动降低只作用于玻璃着色。
- **材质**：柔和（`regular`）与通透（`clear`）两种材质在当前主题下的模糊、厚度、色散、染色、高光和阴影。切换主题后调整的是另一组值。
- **形体**：融合距离、悬浮高度、圆角。
- **恢复默认**与**复制参数**：复制出的 JSON 可以直接传给 `setGlassDefaults()`。

面板修改的是全局默认参数，只影响没有单独声明对应 `data-glass-*` 属性的玻璃。顶栏、分类筛选、商品按钮和展示区的玻璃都使用默认的光学参数；主物信息牌、购物袋和面板自己为了保证文字可读，固定了染色或模糊。

收起时把圆形按钮拖到其他玻璃附近，可以观察融合与遮挡。

## 已知问题

- 高分辨率下整页快照本身就超出预算。在桌面 GPU 上模拟 DPR 3（4689 × 3039）时，完全不画玻璃也只有约 47–50 帧。文字默认按设备倍率绘制，掉帧时只自动降低玻璃着色分辨率；要进一步提速只能用 `maxPixelRatio` 或 `maxPixels` 降低画布分辨率，代价是文字变软。数据见[性能记录](docs/performance/2026-11-13-fill-rate/README.md)，没有在真机上测量过。
- SVG 滤镜回退只在 Chromium 内核上生效，面积超过 12 万 CSS 像素的玻璃（调参面板、购物袋）只有模糊；展开调参面板时有几帧卡顿。
- 展开调参面板的约 0.8 秒内会掉到 50 帧左右。面板用布局尺寸做动画，每帧都要重新生成内容纹理。
- 冷启动后第一次滚动仍会因浏览器首次栅格化而掉帧，见[上一轮记录](docs/performance/2026-11-11-scroll/README.md)。
- 暂停视频后滚动，部分玻璃上的文字可能缺失。该问题已在本地调查中复现，尚未解决。
- 打开购物袋后，其他玻璃效果异常和内容偶发消失的问题已有用户反馈，原因尚待定位。

## 范围与来源

这是对 Apple 视觉行为的 Web 近似实现，不是 Apple 原生材质。同层融合使用三维平滑距离场近似表面张力。背景语义适配、设备姿态光照和不同玻璃层间的递归折射尚未实现。详细限制见 [视觉依据](docs/APPLE_LIQUID_GLASS_REFERENCE.md)。

[liquid-glass-studio](https://github.com/iyinchao/liquid-glass-studio) 提供了折射、色散、SDF 和多遍模糊的研究参考。花朵视频使用该项目引用的 Pixabay / Pexels 素材，商品图保存在 `apps/demo/public/products/`。Apple 参考截图只在研究文档中引用，不作为商店素材。
