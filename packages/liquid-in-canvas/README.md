# liquid-in-canvas

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

Add liquid glass to live HTML with **HTML-in-Canvas and WebGPU**. Glass can refract and magnify the background, split colors, fuse with nearby glass on the same layer, and deform when pressed. The renderer handles content occlusion and lets glass flow between elements. Add an attribute to an ordinary HTML element to turn it into glass. Its content stays clickable and focusable.

When canvas mode is unavailable, the library uses the same attributes with a fallback. Chromium-based browsers use `backdrop-filter` with an SVG displacement filter for edge refraction, dispersion, and rim highlights. The CSS fallback uses `backdrop-filter` alone.

## Installation

```sh
pnpm add liquid-in-canvas
```

The package has zero runtime dependencies. The canvas renderer uses WebGPU directly and loads only after the browser passes the capability check. In the production demo build, it is about 66 kB minified and 23 kB gzipped. Canvas mode requires HTML-in-Canvas, WebGPU, and `GPUQueue.drawElementImageToTexture()`. Development used Chrome 157.

## Usage

```html
<div id="app">
  <div style="position: relative">
    <button data-liquid-glass data-glass-radius="999">Browse collection</button>
  </div>
</div>
```

```ts
import { mountLiquidGlass } from 'liquid-in-canvas'

const glass = await mountLiquidGlass({
  root: document.querySelector('#app')!,
  canvasClass: 'stage',
})

console.log(glass.mode) // 'canvas', 'svg', or 'css'
```

In canvas mode, `mountLiquidGlass` creates a `<canvas content="drawable">` at the root's original position and moves the root into it. Use CSS to size the canvas, typically to fill the viewport.

```css
.stage {
  position: fixed;
  inset: 0;
  width: 100dvw;
  height: 100dvh;
  display: block;
}
#app[drawable] {
  width: 100dvw;
  height: 100dvh;
  overflow: clip;
}
```

In canvas mode, put scroll containers inside the root.

### Rendering modes

| `mode` | Behavior |
| --- | --- |
| `'auto'` (default) | Tries `canvas`, `svg`, and `css` in that order. If canvas support is missing, initialization fails, or a runtime fault occurs, it falls back and reports the reason through `onFault`. |
| `'canvas'` | Requires canvas support and throws `StageUnsupportedError` if it is missing. Initialization errors propagate to the caller. Runtime faults call `onFault` so the caller can decide how to recover. |
| `'svg'` | Uses `backdrop-filter` with an SVG displacement filter. It falls back to `'css'` when SVG backdrop filters are unavailable. Read the returned `mode` to see which renderer is active. |
| `'css'` | Uses `backdrop-filter` alone. |

Both fallback renderers leave elements in place.

| Fallback | Effects | Browser support |
| --- | --- | --- |
| `svg` | Blur, tint, rounded corners, shadows, edge refraction, dispersion, and directional rim highlights | Chromium-based browsers. Check with `supportsSvgBackdropFilter()`. |
| `css` | Blur, tint, rounded corners, shadows, and a rim highlight | Browsers that support `backdrop-filter` |

Same-layer fusion, content occlusion, and press deformation require canvas mode. In SVG mode, glass larger than 120,000 CSS px² uses blur only. The filter cost scales with area, and a changing backdrop requires a fresh calculation each frame. Refraction over an unblurred backdrop (`data-glass-blur="0"`) looks coarser than canvas refraction because the displacement filter samples at whole-pixel increments.

```ts
const glass = await mountLiquidGlass({
  root,
  mode: 'auto',
  onFault(fault) {
    // fault.kind: 'unsupported' | 'init' | 'runtime'
    console.warn('Using a fallback renderer', fault)
  },
})

glass.dispose() // Stop rendering and restore the page to its pre-mount state.
```

To switch renderers at runtime, call `dispose()` and mount again with the new `mode`. Moving the root resets scroll positions inside it and pauses playing videos. Restore them from your application as needed.

When using a framework, mount your app in `beforeStart`. The root is already in its final position when the callback runs. Rendering starts after the callback.

```ts
await mountLiquidGlass({
  root,
  beforeStart: () => app.mount(root),
})
```

Use `detectStageSupport()` to check capabilities before choosing what to show.

## Element attributes

Add `data-liquid-glass` to the element you want to render as glass. Give the element a transparent background and use an ordinary element without `drawable` as its positioning parent.

| Attribute | Meaning | Default |
| --- | --- | --- |
| `data-glass-variant` | Selects the `regular` or `clear` defaults below | `regular` |
| `data-glass-radius` | Corner radius. Accepts one to four values in CSS order. | 28 |
| `data-glass-blur` | Standard deviation of the backdrop's Gaussian blur, 0–80 | 18 / 0 |
| `data-glass-refraction` | Reference half-thickness of the glass volume, 0–80. The renderer caps it at 30% of the shorter side and applies a 2 px minimum. | 80 |
| `data-glass-bevel-width` | Horizontal bevel width as a multiple of the half-thickness, 0.1–4, capped at half the shorter side | 0.8 |
| `data-glass-bevel-height` | Vertical bevel height as a multiple of the half-thickness, 0.05–1. At 1, the bevel spans the full half-thickness. | 1 |
| `data-glass-bevel-curve` | Superellipse exponent of the bevel, 1–8. At 1 the bevel is a straight slope, at 2 it is an elliptical arc, and higher values approach a right angle. | 2.75 |
| `data-glass-bottom-bevel` | Ratio of the bottom bevel to the top bevel, 0–1. At 0, the bottom is flat with a square edge. | 1 |
| `data-glass-dispersion` | Strength of the separation between RGB samples, 0–1 | 0.05 |
| `data-glass-lens` | Convex lens strength, 0–0.6. The center magnifies the backdrop by about 1 / (1 − lens). Long, narrow shapes magnify along the short axis only. | 0 |
| `data-glass-saturation` | Saturation multiplier for the backdrop seen through the glass, 0–3 | 1.3 / 1.15 |
| `data-glass-brightness` | Brightness multiplier for the backdrop seen through the glass, 0.5–1.5 | 1.06 in light mode and 1 in dark mode / 1 |
| `data-glass-tint` | Hex tint color | Theme-dependent |
| `data-glass-tint-alpha` | Tint opacity, 0–1 | Theme-dependent |
| `data-glass-specular` | Rim highlight intensity, 0–2 | 0.7 / 0.9 |
| `data-glass-shadow` | Outer shadow intensity, 0–1. Canvas mode draws fainter shadows over dark backdrops and photos. | 0.16 / 0.12 |
| `data-glass-shadow-size` | Shadow spread, 0–100 | 32 / 28 |
| `data-glass-layer` | Stacking layer. Higher layers appear in front. Fusion occurs within each layer. | 0 |
| `data-glass-fusion` | Fusion distance. Set to 0 to disable fusion. | 32 |
| `data-glass-elevation` | Distance from the bottom of the glass to the backdrop | 16 |
| `data-glass-anchor` | Selector for the ancestor used to position the glass | `offsetParent` |
| `data-glass-morph` | An empty value or `true` animates changes to the element's own position or size. Any other value also names the morph so elements can share it. `false` turns it off. The `true` / `false` switch requires 0.3.0+. | Off |
| `data-glass-morph-stretch` | Stretch during a morph, 0–2. At 0 the glass moves as a single piece. Higher values pull the front and rear farther apart and lengthen the trail. | 1 |
| `data-glass-morph-bounce` | Bounce during a morph, 0–1. At 0 the front edge stops at the destination. | 0.33 |
| `data-glass-morph-wobble` | Wobble during a morph, 0–1. The glass compresses on arrival, then alternates between compressing and stretching. At 0 it settles without wobbling. | 0.35 |
| `data-glass-morph-content` (0.3.0+) | How the glass content behaves during a morph. `static` keeps it at the element's position and reveals it as the glass expands during a size change. `clip` keeps it in place and clips it to the volume, like `overflow: hidden`. `follow` stretches, bounces, and wobbles it with the volume. | `static` |
| `data-glass-materialize` | Appearance and removal transition. When the glass first appears or becomes visible, it starts by bending light, then becomes frosted and briefly overshoots. When hidden or removed, it fades in place. Set to `none` or `false` (0.3.0+) to disable it. | On |

Lengths are in CSS pixels. When two defaults are listed, the order is `regular / clear`. The lens, morph, and materialization attributes require canvas mode. Use canvas for lens magnification and canvas or SVG for edge refraction and dispersion.

### Option scopes (0.3.0+)

Add `data-glass-scope` to an ancestor to make its `data-glass-*` options the defaults for all glass inside it, much like a UI library's `ThemeProvider`. Each option is looked up on the glass element first, then on scopes from the nearest outward, then in the global defaults, so scopes can nest and an inner scope overrides only the options it sets. The scope element doesn't need to be glass. Give a pure wrapper `display: contents` to keep it out of the layout.

```html
<section data-glass-scope data-glass-variant="clear" data-glass-layer="2" style="display: contents">
  <button data-liquid-glass>Inherits clear and layer 2</button>
  <button data-liquid-glass data-glass-variant="regular">Its own attribute wins</button>
</section>
```

`data-glass-morph` isn't inherited, because its name identifies a single piece of glass and passing it down would put every glass in the scope into the same morph. Glass updates as soon as an option on its scope changes.

Canvas mode also supports these attributes.

- Add `data-glass-clip` to an ordinary ancestor to clip descendant glass and shadows to its rectangle.
- Mark the modal root with `data-glass-modal` and its scrim with `data-glass-scrim`. While the modal is open, the scrim opacity controls how much the glass outside it dims.
- Add `data-glass-fade` to a page transition container to apply its `opacity` to the glass inside it.
- Use `data-stage-overlay` for a transparent foreground layer sampled separately from the page, such as a transition that crosses multiple pieces of glass. `data-stage-overlay="5"` appears above glass below layer 5 and below glass at layer 5 or higher. An empty value places it above all glass. Add at most one overlay per page and put it in the DOM before rendering starts.

### TypeScript types

`LiquidGlassAttributes` describes these attributes and their accepted values. Numeric attributes accept numbers or numeric strings. `data-glass-variant` accepts `regular` and `clear`. `data-glass-tint` starts with `#`. Switch attributes such as `data-liquid-glass` and `data-glass-scope` accept an empty string, a boolean, or no value in markup.

To check attributes on native elements in Vue templates or React JSX, add the matching type entry point to your tsconfig.

```jsonc
{
  "compilerOptions": {
    "types": ["liquid-in-canvas/vue"] // Use "liquid-in-canvas/react" for React.
  }
}
```

You can also add `/// <reference types="liquid-in-canvas/vue" />` to a `.d.ts` file. For example, TypeScript will flag `<div data-glass-variant="frosted">`, and your editor can suggest the available attributes. The type entry points extend the `HTMLAttributes` types from `vue` and `@types/react`, both optional peer dependencies.

Use `LiquidGlassAttributes` when collecting attributes in an object for Vue's `v-bind` or a JSX spread.

```ts
import type { LiquidGlassAttributes } from 'liquid-in-canvas'

const pill: LiquidGlassAttributes = { 'data-liquid-glass': '', 'data-glass-variant': 'clear', 'data-glass-blur': 1 }
```

Since 0.3.0, you can bind switch attributes to booleans. Frameworks render `false` as the string `"false"`, and the stage treats a contract attribute set to `"false"` as absent, the same as binding `undefined` or `null`.

```tsx
<button data-liquid-glass={active} data-glass-morph={active && 'tabs'}>All</button>
```

## Nested glass and liquid morph

Nest one piece of glass inside another to mark the active item in a group of tabs.

```html
<div data-liquid-glass data-glass-radius="999" role="group">
  <button data-liquid-glass data-glass-morph="tabs" data-glass-variant="clear" aria-pressed="true">All</button>
  <button aria-pressed="false">Home</button>
  <button aria-pressed="false">Kitchen</button>
</div>
```

- Nested glass shares its parent's glass layer and is drawn above the parent's glass volume. The parent captures the HTML for both, so text appears clearly above the inner surface. Nested glass fuses only with sibling glass inside the same parent. Nesting supports one level.
- Nested glass refracts the page backdrop directly, which gives it the appearance of a clear piece inset into the frosted outer glass.
- To switch the active item, move `data-liquid-glass` and the matching `data-glass-morph` value to the new button. In a framework, bind both attributes to the active state. In canvas mode, the leading edge reaches the destination first and overshoots slightly. The rear edge trails behind, then the stretched glass contracts into place.
- Use an empty `data-glass-morph` to animate an element's own layout position or size. When dragging, the glass follows the element and pulls a fused droplet behind it, including along diagonals. On release, the glass overshoots and bounces back as the droplet swings past it, contracts, and settles. Set a nonzero fusion distance to show the trail. Position is measured using `offsetLeft` and `offsetTop`, so update the glass element's own `left`, `top`, or layout position. This transition responds to layout changes of the glass element itself, independent of scrolling, viewport resizing, ancestor movement, and CSS transforms.
- If another piece of glass with the same morph name is present, the new piece flows out of it. For example, place a panel at its final position in one step and give it the same name as the button that opens it. The glass grows from the button's size and position and reveals the panel content as it expands. On removal, the panel flows back into the button.
- Set the element's final size in one step and let the glass animate between sizes. Changing the element's size every frame rebuilds its content snapshot on every frame and can make text and controls flicker.
- By default, the bounce and wobble as the glass settles don't move the content. Use `data-glass-morph-content="clip"` to keep the content inside the wobbling glass, or `follow` to make it deform with the glass as if printed on it.
- Adjust the motion with `data-glass-morph-stretch`, `data-glass-morph-bounce`, and `data-glass-morph-wobble`. Their global defaults are `morphStretch`, `morphBounce`, and `morphWobble`.
- With reduced motion, the glass goes directly to its destination. In fallback modes, the highlight switches immediately to the active item.

## Global defaults

Attributes omitted from an element use the global defaults. You can update those defaults at any time, and mounted pages apply the changes on the next frame.

```ts
import { getGlassDefaults, onGlassDefaultsChange, resetGlassDefaults, setGlassDefaults } from 'liquid-in-canvas'

setGlassDefaults({
  fusion: 40,
  materials: {
    regular: {
      dark: { blur: 24, tintAlpha: 0.36 },
      light: { blur: 24 },
    },
  },
})

getGlassDefaults().materials.regular.dark.blur // 24
const stop = onGlassDefaultsChange(defaults => console.log(defaults))
resetGlassDefaults()
```

`setGlassDefaults()` applies only the fields you pass. It clamps numbers to `GLASS_LIMITS` and ignores invalid values. `getGlassDefaults()` returns a frozen object. The built-in values are available as `BUILTIN_GLASS_DEFAULTS`.

Materials have `light` and `dark` variants. The theme comes from the `theme` mount option or `glass.setTheme()`, then `<html data-theme="light|dark">`, then the system color scheme.

## Glass tuner

`liquid-in-canvas/tuner` ships a framework-agnostic tuning panel: a draggable round glass button that opens a panel for editing the global defaults live (materials, bevel profile with a ray diagram, fusion, liquid motion). **Copy JSON** produces an object you can pass straight to `setGlassDefaults()`. Given a mount, it also adjusts resolution limits, adaptive fallback and optics, and shows the actual pixel ratios.

```ts
import { mountLiquidGlass } from 'liquid-in-canvas'
import { createGlassTuner } from 'liquid-in-canvas/tuner'

const glass = await mountLiquidGlass({ root })
// Create it after your framework has mounted into root: the panel is appended to root,
// so in canvas mode it is drawn along with the rest of the page.
const tuner = createGlassTuner({ mount: glass })

tuner.setHidden(true) // hide the button while a modal is open
tuner.destroy()
```

- `container`: where the panel is appended. Defaults to `mount.root`, or `document.body` without a mount. In canvas mode it must be inside the root.
- `renderer`: a custom source for the renderer section (`GlassTunerRenderer`). Switching renderers means `dispose()` and mounting again, so you implement `setMode`; `rendererFromMount(() => currentMount, { setMode })` follows the new mount after a remount. Call `tuner.update()` when the renderer changes outside the panel.
- `locale` (`'zh' | 'en'`, defaults to `<html lang>`), `theme` (follows the page theme like the stage by default; the panel edits the current theme's materials), `layer` (glass layer while open, default 1), `zIndex`, `position`, `hidden`, `open`.
- The panel injects its own stylesheet into `<head>` and does not rely on a CSS reset. Colors come from custom properties such as `--lg-tuner-text`, `--lg-tuner-line` and `--lg-tuner-accent`; override them on `.lg-tuner` to match your page.
- The button and the panel share a `data-glass-morph` name: in canvas mode the panel's glass flows out of the button; the fallbacks use a scale transition.

## Resolution and performance

Canvas resolution controls how sharply page text is drawn. Glass shading has its own resolution. Reducing that resolution is less visible because the backdrop is already refracted and blurred.

```ts
await mountLiquidGlass({
  root,
  resolution: {
    maxPixelRatio: 3, // Canvas pixel ratio limit. Controls text sharpness. Defaults to 3.
    maxPixels: Infinity, // Total canvas pixel limit. Defaults to unlimited.
    maxGlassPixelRatio: 2, // Glass shading pixel ratio limit. Defaults to 2.
    adaptive: true, // Lowers quality during sustained frame drops. Enabled by default.
    minPixelRatio: Infinity, // Lowest canvas pixel ratio adaptive quality may use. The default, Infinity, never softens text.
  },
})

glass.stage?.setResolution({ maxGlassPixelRatio: 1.5 })
glass.stage?.getMetrics() // Includes dpr, targetDpr, and glassDpr.
```

- When frames drop for a sustained period, adaptive quality switches from `hybrid` or `raymarch` to `profile` first, then lowers the glass shading ratio in ×0.75 steps to as low as half the initial ratio. If you set `minPixelRatio`, it lowers canvas resolution last, usually cutting the pixel count to 75% per step and by up to half when rendering is much slower. It restores quality in reverse order. Each step must shorten the interval between draws by at least 1 ms and 5% to stay in effect. Otherwise, it rolls back the step and skips that adjustment for a while. Read the active settings from `stage.getMetrics()` using `optics`, `glassDpr`, and `dpr`.
- The cost of taking a page snapshot, drawing the page, and blurring it scales with canvas pixels. A large canvas, such as a fullscreen window on a 5K display, can make the page snapshot itself the bottleneck. Only a lower canvas resolution helps then, and it softens all text, so adaptive quality leaves the canvas alone by default. To trade text sharpness for frame rate, set `minPixelRatio` to a lower value such as `1`, or cap the canvas yourself with `maxPixelRatio` or `maxPixels`.
- Set `optics` in `mountLiquidGlass`, in `CanvasStage`, or with `stage.setOptics()`. `profile` looks up rays traced through the cross-section by distance from the outline. `raymarch` finds ray intersections by stepping through a 3D distance field. Both give the same result on straight edges, capsules and corners at least as wide as the bevel, with approximations in `profile` at corners tighter than the bevel and at fusion joints. The GPU cost of `profile` is about one third that of `raymarch`. `hybrid`, the default, uses lookups except near fusion joints, edges cut by `data-glass-clip` and corners tighter than the bevel, where stationary glass matches `raymarch`.
- `fieldCache` applies to `hybrid` and defaults to `true`. Set it in `mountLiquidGlass`, in `CanvasStage`, or with `stage.setFieldCache()`. The renderer caches ray intersections after the glass geometry has been stationary for about 0.1 s and uses them to sample the current backdrop each frame, including while a video plays or the page scrolls. While group members move relative to each other, deform under a press, or morph, the group uses the profile lookup. After the motion settles, it computes new intersections and blends them in. The cache scales with the shading resolution and is capped at 48 MB. Set `fieldCache` to `false` to raymarch joints, clip edges and tight corners every frame, including during motion. The cost then scales with their area.
- Where layers overlap, the upper glass samples a backdrop that includes the glass beneath it. The renderer supports up to three backdrop levels and limits extra compositing and blur to the overlap regions.
- Nearby or overlapping pieces of glass on the same layer form a fusion group. Each pixel in the group checks its distance to every member. Use `data-glass-layer` to give large panels their own layer so they render independently of the controls underneath.

## Known issues

- When computing scroll overflow, Chrome 157's HTML-in-Canvas implementation adds the translation passed to `canvas.updateElementGeometry()` on top of the drawable element's layout position, counting the position twice. Hit testing is correct. Fixed glass near the right or bottom of the viewport can therefore stretch its scroll container to about twice its position plus its size and add stray scrollbars. The glass tuner works around this with `overflow: clip` on `.lg-tuner`. Put your own fixed glass in a fixed, viewport-sized container with `overflow: clip`. Glass that scrolls with the page usually adds only a small extra range. See `docs/known-issues/drawable-scroll-overflow.md` in the repository for details and a minimal repro.

## Other exports

- `liquid-in-canvas/canvas` exports `CanvasStage`. Use it when you manage the canvas yourself. `mountLiquidGlass` loads it on demand.
- `CssGlassStage` is the fallback renderer. Its `refraction` option controls the use of the SVG filter.
- `glassProfile`, `glassProfileOutline`, and `glassEdgeTilt` compute the glass cross-section, its outline, and the angle at the edge from the thickness and bevel settings. The canvas and SVG renderers share these calculations, which can also be used to draw a cross-section.
- `liquid-in-canvas/vue` and `liquid-in-canvas/react` provide the Vue and React type declarations.
- `liquid-in-canvas/motion` exports `advanceSpring`, `reducedMotionQuery`, and `prefersReducedMotion` independently of the canvas renderer. Use the damped spring and the same parameters as the glass press effect to give your own animations a similar feel.

## Scope

The library approximates the visual behavior of Apple Liquid Glass on the web. Same-layer fusion uses a smooth distance field to approximate surface tension. Stacked glass refracts through up to three backdrop levels. Layers beyond that share the top backdrop. The implementation focuses on page geometry and material settings. A fuller reproduction would also require content-aware materials and lighting driven by device motion. See the repository's `docs/` directory for design notes.
