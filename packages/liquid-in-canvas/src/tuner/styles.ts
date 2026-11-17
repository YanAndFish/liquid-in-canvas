/** 注入到 `<head>` 的样式表 id；页面上所有面板共用一份。 */
export const TUNER_STYLE_ID = 'liquid-in-canvas-tuner-style'

/**
 * 面板样式。颜色都来自 `--lg-tuner-*` 自定义属性，在 `.lg-tuner` 或它的祖先上声明即可覆盖；
 * 主题缺省值写在 `:where()` 里，不增加优先级。元素自带重置，不依赖页面的 CSS 重置。
 *
 * `.lg-tuner` 的 `overflow: clip` 绕过 Chrome 的问题：画布里平移过的 drawable 在计算滚动范围时位置被算两次，
 * 贴在视口右下的按钮会把页面撑出滚动条，见 docs/known-issues/drawable-scroll-overflow.md。
 */
export const TUNER_CSS = `
:where(.lg-tuner[data-theme='dark']) {
  --lg-tuner-text: #f3efe7;
  --lg-tuner-text-soft: rgba(243, 239, 231, 0.85);
  --lg-tuner-muted: #a2a1a9;
  --lg-tuner-line: rgba(243, 239, 231, 0.12);
  --lg-tuner-line-strong: rgba(243, 239, 231, 0.32);
  --lg-tuner-hover: rgba(255, 255, 255, 0.05);
  --lg-tuner-inset: rgba(255, 255, 255, 0.03);
  --lg-tuner-accent: #b8f5d0;
  --lg-tuner-accent-soft: rgba(184, 245, 208, 0.1);
  --lg-tuner-accent-line: rgba(184, 245, 208, 0.4);
  --lg-tuner-pressed-text: #101113;
  --lg-tuner-error: #e0786c;
}
:where(.lg-tuner[data-theme='light']) {
  --lg-tuner-text: #1d1d1f;
  --lg-tuner-text-soft: rgba(23, 21, 17, 0.85);
  --lg-tuner-muted: #625e55;
  --lg-tuner-line: rgba(23, 21, 17, 0.14);
  --lg-tuner-line-strong: rgba(23, 21, 17, 0.32);
  --lg-tuner-hover: rgba(23, 21, 17, 0.05);
  --lg-tuner-inset: rgba(255, 255, 255, 0.42);
  --lg-tuner-accent: #1d6a4b;
  --lg-tuner-accent-soft: rgba(29, 106, 75, 0.1);
  --lg-tuner-accent-line: rgba(29, 106, 75, 0.4);
  --lg-tuner-pressed-text: #f5f5f7;
  --lg-tuner-error: #c4493b;
}
.lg-tuner { position: fixed; inset: 0; overflow: clip; pointer-events: none; color: var(--lg-tuner-text); font-size: 12px; line-height: 1.4; text-align: left; -webkit-font-smoothing: antialiased; }
.lg-tuner[data-hidden] { display: none; }
.lg-tuner [hidden] { display: none !important; }
.lg-tuner *, .lg-tuner *::before, .lg-tuner *::after { box-sizing: border-box; }
:where(.lg-tuner) :is(h2, h3, p, figure) { margin: 0; padding: 0; font: inherit; }
:where(.lg-tuner) button { margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; text-transform: none; -webkit-tap-highlight-color: transparent; }
:where(.lg-tuner) input { margin: 0; font: inherit; }
:where(.lg-tuner) svg { display: block; }
.lg-tuner-anchor { position: absolute; }
.lg-tuner-launcher { position: absolute; display: grid; place-items: center; border-radius: 50%; pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; color: var(--lg-tuner-text); }
.lg-tuner-launcher.is-dragging { cursor: grabbing; }
.lg-tuner-panel { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 28px; overflow: clip; pointer-events: auto; color: var(--lg-tuner-text); }
.lg-tuner-content { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.lg-tuner-heading { display: flex; justify-content: space-between; align-items: center; padding: 20px 20px 15px; border-bottom: 1px solid var(--lg-tuner-line); }
.lg-tuner-heading h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.03em; }
.lg-tuner-heading p { margin-top: 5px; font-size: 10px; color: var(--lg-tuner-text-soft); }
.lg-tuner-close { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; cursor: pointer; }
.lg-tuner-close:hover { background: var(--lg-tuner-hover); }
.lg-tuner-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 20px 8px; }
.lg-tuner-section { padding: 14px 0 12px; border-bottom: 1px solid var(--lg-tuner-line); }
.lg-tuner-section:last-child { border-bottom: 0; }
.lg-tuner-section h3 { font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lg-tuner-text-soft); }
.lg-tuner-segment { display: flex; gap: 4px; margin-top: 10px; padding: 4px; border-radius: 14px; background: var(--lg-tuner-hover); border: 1px solid var(--lg-tuner-line); }
.lg-tuner-segment button { flex: 1; height: 32px; border-radius: 10px; font-size: 12px; font-weight: 550; cursor: pointer; }
.lg-tuner-segment button[aria-pressed='true'] { background: var(--lg-tuner-text); color: var(--lg-tuner-pressed-text); }
.lg-tuner-segment button:disabled { opacity: 0.4; cursor: default; }
.lg-tuner-field { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 2px 10px; margin-top: 11px; font-size: 12px; }
.lg-tuner-field output { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--lg-tuner-text-soft); }
.lg-tuner-field input[type='range'] { grid-column: 1 / -1; width: 100%; height: 18px; accent-color: var(--lg-tuner-text); cursor: pointer; }
.lg-tuner-field.is-color { grid-template-columns: 1fr auto auto; align-items: center; }
.lg-tuner-field input[type='color'] { width: 34px; height: 24px; padding: 0; border: 1px solid var(--lg-tuner-line); border-radius: 7px; background: transparent; cursor: pointer; }
.lg-tuner-check { display: flex; align-items: center; gap: 8px; margin-top: 11px; font-size: 12px; cursor: pointer; }
.lg-tuner-check input { flex: none; width: 15px; height: 15px; accent-color: var(--lg-tuner-text); }
.lg-tuner-hint { margin-top: 9px; font-size: 10px; line-height: 1.6; color: var(--lg-tuner-text-soft); }
.lg-tuner-hint.is-error { color: var(--lg-tuner-error); overflow-wrap: anywhere; }
.lg-tuner-footer { display: flex; gap: 8px; padding: 12px 20px 0; border-top: 1px solid var(--lg-tuner-line); }
.lg-tuner-footer button { flex: 1; height: 36px; border: 1px solid var(--lg-tuner-line); border-radius: 18px; font-size: 12px; font-weight: 550; cursor: pointer; }
.lg-tuner-footer button:hover { background: var(--lg-tuner-hover); }
.lg-tuner-note { margin: 10px 20px 14px; font-size: 9px; line-height: 1.5; text-align: center; color: var(--lg-tuner-text-soft); }
.lg-tuner-profile { margin-top: 12px; padding: 8px 8px 7px; border: 1px solid var(--lg-tuner-line); border-radius: 14px; background: var(--lg-tuner-inset); }
.lg-tuner-profile svg { width: 100%; height: auto; overflow: visible; }
.lg-tuner-profile-glass { fill: var(--lg-tuner-accent-soft); stroke: var(--lg-tuner-text); stroke-width: 1.2; stroke-linejoin: round; }
.lg-tuner-profile-guide { fill: none; stroke: var(--lg-tuner-line-strong); stroke-width: 0.8; stroke-dasharray: 2 2; }
.lg-tuner-profile-ray { fill: none; stroke: var(--lg-tuner-accent-line); stroke-width: 0.9; }
.lg-tuner-profile-dot { fill: var(--lg-tuner-accent); }
.lg-tuner-profile-ground { stroke: var(--lg-tuner-line-strong); stroke-width: 1; }
.lg-tuner-profile-hatch { stroke: var(--lg-tuner-line); stroke-width: 1; }
.lg-tuner-profile-axis { stroke: var(--lg-tuner-line); stroke-width: 0.8; stroke-dasharray: 1 3; }
.lg-tuner-profile-measure { stroke: var(--lg-tuner-line-strong); stroke-width: 0.8; stroke-dasharray: 2 2; }
.lg-tuner-profile-label { font-size: 8px; fill: var(--lg-tuner-muted); }
.lg-tuner-profile figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 8px; margin-top: 6px; font-size: 10px; font-variant-numeric: tabular-nums; color: var(--lg-tuner-text-soft); }
`

let users = 0

export function retainTunerStyle(): () => void {
  users++
  if (users === 1 && !document.getElementById(TUNER_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = TUNER_STYLE_ID
    style.textContent = TUNER_CSS
    document.head.append(style)
  }
  let released = false
  return () => {
    if (released)
      return
    released = true
    users--
    if (users === 0)
      document.getElementById(TUNER_STYLE_ID)?.remove()
  }
}
