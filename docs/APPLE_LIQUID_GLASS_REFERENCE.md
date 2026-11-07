# Liquid Glass 的视觉依据

本项目用 HTML-in-Canvas 和 WebGPU 重建 Liquid Glass 的视觉行为。目标以 Apple 官方演示和实际系统界面为准。`liquid-glass-studio` 用于研究 SDF、折射和多遍模糊的实现方法。

Apple 公开资料没有提供完整的原生材质着色器。下面明确区分官方描述、截图观察和本项目的实现选择。资料检查日期为 2026-11-07。

## 实际 UI 截图

这些图片来自 Apple 的 iPhone 用户指南，页面选择的版本为 **iOS 26**。它们展示完整应用界面，适合检查控件比例、对比度和内容层级。图片不是本项目截图，也不是本机 iPhone 实测；具体小版本和辅助功能设置无法从图片确认。图片版权归 Apple，以下直接引用官方地址。

### 照片：图库与底部导航

[来源：Get started with Photos on iPhone](https://support.apple.com/en-gb/guide/iphone/iphc259d0ac7/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/6c0c1af2cf439f969cee40af356f077a.png" width="280" alt="iOS 26 照片图库，底部为图库、精选集与独立搜索按钮">

观察：照片保持清晰，底部导航有明显的浅色承托。选中项在整块材质内部呈现为浅填充。搜索按钮与导航组分开，周围保留间距。

项目对应：商品卡片使用普通内容表面；筛选项共享一个胶囊，内部选中背景以弹簧移动。播放按钮与场景选择器分组。

### 照片：回忆列表

[来源：Get started with Photos on iPhone](https://support.apple.com/en-gb/guide/iphone/iphc259d0ac7/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/61de8a3b3a33d86f531d0a6c4359eaa7.png" width="280" alt="iOS 26 照片回忆页，内容图片占据主体，控制按钮位于独立浮层">

观察：主内容有清晰的图文层级。玻璃只承担返回、播放等操作，不为整张内容图片增加折射外框。

项目对应：首页照片与文案直接呈现；玻璃用于浏览、播放和外观设置。材质选择收在外观菜单中。

### Safari：起始页

[来源：Customize your Safari settings on iPhone](https://support.apple.com/en-gb/guide/iphone/iphb3100d149/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/b9b877fe98989cc0fdb2b50bbe882bba.png" width="280" alt="iOS 26 Safari 起始页，底部搜索框和圆形操作按钮浮在页面之上">

观察：底部搜索框透出背景色，但没有牺牲文字清晰度。搜索框与两侧圆形操作使用一致的高度和曲率。内容列表与操作层有明显区分。

项目对应：导航按用途分组，使用统一的圆角和触摸尺寸。Regular 材质柔化背景并叠加主题染色。购物袋浮在页面边缘，四周留白。

## 官方动态演示

[Meet Liquid Glass，WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/) 用于研究运动和光照。已抽帧查看约 2:40 的细轮廓反光，以及 3:00–5:20 的播放按钮、按压、滑块和应用控件示例。

- 玻璃通过折射和透镜形成轮廓，亮边不需要铺满整个表面。
- 接触产生局部亮光和形变。
- 菜单从触发点展开，尺寸变大时具有更厚、更柔和的材质。

本项目将上述行为近似为三维圆角实体、窄轮廓反光和按压形变。按钮展开为菜单时，同步改变宽高、模糊和染色。折射模型和弹簧参数是本项目的实现选择，不代表 Apple 内部参数。

## 设计与可访问性

[Materials — Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials) 区分 Regular 与 Clear；[Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/) 说明控制分组、同心圆角和滚动边缘的设计。

实现检查包括：

- 常驻导航和购物袋使用 Regular；媒体区域的 Clear 配合暗色衬底和白色文字。
- 控件文字来自独立 HTML 快照，不随背景折射。
- 视频可暂停，离屏时暂停，减少动态效果时默认不自动播放。
- 系统要求减少动态效果时，菜单与选中项直接到达目标位置。
- 菜单支持 Escape，关闭后的内容设置 `inert` 和 `aria-hidden`。
- 减少透明度与增强对比度使用 CSS 媒体查询。

## 实现范围

本项目支持圆角实体的三维折射、按波长计算的色散、五级高斯模糊、同层融合、HTML 内容遮挡、屏幕空间环境反光、按压形变和菜单尺寸插值。

原生系统的完整环境光模型、设备姿态驱动、语义化背景识别，以及不同玻璃层间的递归折射没有实现。三维 Regular 使用主题染色，不等同于系统的完整自适应材质。浏览器支持检查通过，也不能替代对实际 GPU 画面的检查。

## 补充截图观察

用户提供的 Dock、控制面板、Safari 及演示视频截图显示：边缘存在窄的明暗过渡；背景蓝线在玻璃内产生位移；邻近绿色在未直接重叠的轮廓上也能出现。截图中的色带既可能来自背景本身的颜色，也可能包含色散，不能把全部彩色边缘都归因于 RGB 分离。

三维版本使用圆弧侧壁、入射与出射求交、按波长区分的折射率来近似这些现象。屏幕透镜对照版本使用主体与窄边缘两条采样光路。`tests/visual/liquid-glass.html` 使用独立色块检查位移与色散。它不包含 Apple 图片，方便固定条件下对照参数。

## 三维与融合实验

当前项目使用闭合三维距离场计算入射、出射和折射，并以平滑距离场近似同层表面的连接。这是本项目的实现选择，没有据此推断 Apple 的内部算法。反射环境取自屏幕空间，融合不模拟流体的质量与速度。

顶栏是完整玻璃条，主物信息牌与商品加入按钮也参与第 0 层融合。HTML 层叠顺序控制内容遮挡：被上层玻璃覆盖的文字先写入背景再进行模糊。鼠标移动不会改变高光，定向亮度集中在较细的轮廓区域。
