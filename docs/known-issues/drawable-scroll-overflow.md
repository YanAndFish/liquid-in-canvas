# drawable 平移后滚动范围被算两次（Chrome 157）

## 现象

画布模式下，视口 1280×657 的页面，`#root` 的 `scrollWidth` 却是 2440。2440 = 1188 × 2 + 64：调参面板圆形按钮的 `left` 被算了两次，再加上按钮宽度。纵向同样是 565 × 2 + 64。隐藏面板后滚动条消失。

## 原因

舞台对每块玻璃做两件事：加上 `drawable` 属性，再调用 `canvas.updateElementGeometry(el, { canvasTransform: translate(rect.left, rect.top) })` 告诉浏览器元素画在画布的哪里。

`elementFromPoint` 的结果说明 `canvasTransform` 表示元素在画布上的绝对位置：传单位矩阵时只有点画布左上角才能点中元素，传 `translate(元素位置)` 时点元素原本的位置能点中。所以库的写法是对的。

但 Chrome 计算滚动范围时又把这个平移叠加到元素的布局位置上，位置被算了两次。同一个参数，命中测试正确、滚动范围错误，前后不一致，是 Chrome 157 实验性 HTML-in-Canvas 实现的问题。强制重新排版不会改变结果。

## 最小复现

[`drawable-scroll-overflow.html`](./drawable-scroll-overflow.html) 不使用本库，只用 WebGPU 与 HTML-in-Canvas API：一个 `left: 900px; top: 300px` 的 50×50 drawable，在三种 `canvasTransform` 下记录 `#root.scrollWidth` 和命中测试，结果写在 `window.result`。`translate(900, 300)` 时 `scrollWidth` 变成 900 × 2 + 50 = 1850，命中测试仍然在元素的布局位置。

## 影响与绕过

- 离滚动容器左上角越远的 drawable 撑得越多。贴在视口右下的固定玻璃最明显；随页面滚动的玻璃 `rect` 是视口坐标，一般只多出很小的范围。
- 调参面板在 `.lg-tuner`（铺满视口的 fixed 层）上加了 `overflow: clip`（`packages/liquid-in-canvas/src/tuner/styles.ts`）。
- 页面自己的固定玻璃可以照做：放进一个 `position: fixed; inset: 0; overflow: clip; pointer-events: none` 的容器，玻璃自身恢复 `pointer-events: auto`。
- 需要滚动的容器不能简单地裁剪，只能等 Chrome 修复。
