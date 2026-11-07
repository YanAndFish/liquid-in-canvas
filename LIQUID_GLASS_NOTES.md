# Liquid Glass in Canvas

Stage 03 turns the storefront's cart drawer and showreel panels into Apple-style Liquid Glass. The material is rendered by a three.js WebGPU mesh per surface, driven by `data-liquid-glass` attributes on live DOM inside the canvas.

The short version:

- A glass element gets its own `drawable` snapshot, so the main page snapshot has a hole where it sits.
- A TSL fragment shader samples the page snapshot behind the panel, applies refraction, dispersion, blur, tint, specular and shadow, then composites the panel's own transparent content texture on top.
- The cart drawer is fully glass. It has no opaque panel background. The showreel cards demonstrate the same material over a looping video.

## 1. Apple's material, in implementation terms

Sources read for this stage:

- Apple, [Meet Liquid Glass, WWDC25 session 219](https://developer.apple.com/videos/play/wwdc2025/219/).
- Apple, [Materials, Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials).
- Apple Newsroom, [Apple introduces a delightful and elegant new software design](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/).
- [WWDCNotes summary of session 219](https://wwdcnotes.com/documentation/wwdc25-219-meet-liquid-glass/).

The properties that changed the shader:

| Property | Apple's description | What this project does |
| --- | --- | --- |
| Lensing | The material bends light instead of only scattering it. | Refraction samples the backdrop with an offset along the rounded-rect normal, strongest at the edge. |
| Specular | Highlights move with the material and the light. | A directional rim plus a second fresnel-like glare term. |
| Adaptive tint | The material picks up surrounding colour and separates itself from text underneath. | The backdrop is blurred, then mixed with a theme tint. The tint alpha is an option. |
| Shadow | Larger and denser elements cast more separation. | A projected shadow is generated in the padded margin of the same mesh. |
| Regular and clear | Regular is adaptive and frosted. Clear is more transparent and is only for media-rich content. | `data-glass-variant="regular"` or `clear` changes blur, tint, specular and shadow presets. |
| Navigation layer | Glass belongs above content, not as another content card. | The drawer and the showreel overlay are navigation and media overlays. |
| No glass on glass | Put fills on glass instead of another glass layer. | The header stayed opaque, the drawer content uses fills, and the showreel chips do not overlap. |

The drawer starts below the 64px header. That is a product decision, not a renderer limit. It avoids putting the drawer's close control directly over the page header's bag control. The glass top edge still refracts a little of the header, which is visible as a faint ghost.

## 2. What the reference project contributed

[`iyinchao/liquid-glass-studio`](https://github.com/iyinchao/liquid-glass-studio) is an MIT-licensed WebGL2 and WebGPU recreation of Apple's material. Its useful pieces are:

- A rounded-rect SDF with superellipse corners.
- Edge refraction derived from a thickness and an approximate Snell bend.
- Separate sharp and blurred backdrop samples, mixed by depth into the panel.
- Fresnel and directional glare terms.
- A tint mixed into the glass, plus a dispersive three-channel sample.
- WebGPU multipass rendering with a horizontal and vertical Gaussian blur.

This project reused the SDF, the depth-based sharp-to-blur mix, edge refraction, dispersion, fresnel, glare and the tint model. It did not reuse the single-shape full-screen renderer, the pointer spring, the two-pass blur or the shape merge. The glass here is one mesh per DOM surface, and the blur is one 17-tap kernel because the page texture already exists and a second render target would add resize and colour-space complexity.

## 3. Attribute API

The parser is pure and jsdom-safe in `src/stage/liquid-glass/options.ts`.

```html
<aside
  data-liquid-glass
  data-glass-anchor="#cart-shell"
  data-glass-radius="28 0 0 28"
  data-glass-blur="20"
  data-glass-refraction="26"
  data-glass-dispersion="0.36"
  data-glass-tint="#0b0d12"
  data-glass-tint-alpha="0.34"
  data-glass-specular="0.62"
  data-glass-shadow="0.55"
  data-glass-shadow-size="38"
>
  ...
</aside>
```

| Attribute | Default | Range | Meaning |
| --- | --- | --- | --- |
| `data-liquid-glass` | absent | attribute | Marks the element as a glass surface. The layer adds `drawable`. |
| `data-glass-anchor` | offset parent | CSS selector | A non-drawable ancestor used for stable measurement. |
| `data-glass-radius` | `28` | 0 to 2000 | One to four corner radii, CSS order. |
| `data-glass-blur` | 18 regular, 8 clear | 0 to 80 | Backdrop blur radius in CSS pixels. |
| `data-glass-refraction` | 22 regular, 18 clear | 0 to 80 | Edge lens offset in CSS pixels. |
| `data-glass-dispersion` | 0.25 regular, 0.34 clear | 0 to 1 | Per-channel offset difference. |
| `data-glass-tint` | `#ffffff` dark, `#f7f2e8` light | `#rgb` or `#rrggbb` | Colour mixed into the glass. |
| `data-glass-tint-alpha` | 0.08 dark, 0.34 light | 0 to 1 | Tint strength. |
| `data-glass-specular` | 0.7 regular, 0.9 clear | 0 to 2 | Rim and glare strength. |
| `data-glass-shadow` | 0.4 regular, 0.3 clear | 0 to 1 | Shadow opacity. |
| `data-glass-shadow-size` | 32 regular, 28 clear | 0 to 100 | Shadow falloff and mesh padding. |
| `data-glass-variant` | `regular` | `regular` or `clear` | Selects the preset before explicit attributes override it. |

The drawer binds its tint, tint alpha and blur to the theme. Dark uses a smoked `#0b0d12` at 0.34 and 20px blur. Light falls back to the cream default at 0.62 and 32px blur, because a light page shows more ghost text through glass.

## 4. Render pipeline

### 4.1 Nested drawable snapshots

The drawable root is `#app`. A glass element is also `drawable`.

```text
canvas
  #app drawable                 root snapshot, glass panels excluded
    aside[data-liquid-glass]    separate snapshot, transparent background
```

The HTML-in-Canvas spec says a drawable subtree excludes nested `drawable` descendants. So `drawElementImageToTexture({ source: #app })` produces the page with a hole where each glass element sits. `drawElementImageToTexture({ source: aside })` produces the panel's own content with a transparent background.

That is the key that makes crisp text possible. Without the separate snapshot, the only pixels available are the composited page, and applying a blur to the glass would also blur the text.

### 4.2 Per-surface mesh

`LiquidGlassLayer` owns one `Mesh` per surface. The mesh is a unit plane placed in NDC over the panel's rect, padded by `shadowSize` so the shadow can fall outside the panel. It is rendered after the opaque full-screen page mesh with normal alpha blending.

Each mesh has its own `MeshBasicNodeMaterial` with a TSL `colorNode`. The material is transparent, depth-tested off, depth-written off and tone-mapping off.

### 4.3 Fragment math

For each fragment:

```text
local       rounded-rect local coordinates in CSS pixels, y down
distance    signed distance to the panel's rounded rect
inside      one inside, zero outside, smooth over one CSS pixel
depth       0 at the edge, 1 at the configured refraction thickness
normal      outward normal from the rounded-rect SDF
offset      normal * -refraction * depth^1.6 / viewport
sharp       backdrop sample at screenUV + offset, R/G/B at slightly different offsets
blurred     17-tap kernel around screenUV + offset
frosted     mix(sharp, blurred, depth)
glass       mix(frosted, tint, tintAlpha) + rim + glare
content     panel snapshot at local UV
final       mix(glass, content.rgb, content.a)
```

The output alpha is `inside`, with the shadow alpha in the padded margin. The content texture is sampled with straight alpha.

When the cart is open, page glass surfaces also multiply their material opacity by the remaining brightness of the cart scrim. The drawer surface itself is excluded. Without this, the showreel cards would stay bright above the dimmed page because they are separate meshes, not part of the root snapshot.

### 4.4 Geometry and anchors

`updateElementGeometry` maps the element's border box to the canvas in CSS pixels. A glass element supplies `data-glass-anchor` so the layer can measure its visual rect from a non-drawable ancestor plus `offsetLeft` and `offsetTop`. The showreel frame is `position: sticky`, so its non-drawable rect gives the cards a stable position while the page scrolls.

The layer updates geometry on every paint where the rect changes. The canvas hit-test stack therefore follows the sticky cards and the sliding drawer.

### 4.5 Offscreen paint records

Chrome can give a `drawable` element that first appears outside the viewport an empty paint record. The snapshot does not fill in when the element merely scrolls into view. The showreel cards reproduced this, with `nonEmpty = 0` in their content textures.

The fix is a forced paint. `kickPaint` sets a transparent box-shadow on the surface when it first becomes visible. That invalidates the subtree, and the following paint uploads real content. The measured content alpha count went from 0 to 8403, 740 and 7808 pixels for the three showreel panels.

The same issue explains the initial empty cart drawer. It registers while it is offscreen at `right: -100%`. The layer now waits until the surface intersects the viewport, kicks the paint, and uploads again after the slide's `transitionend`.

## 5. Problems found

### 5.1 CSS transforms make the snapshot empty

A drawable element with `transform: translateX(50px) scale(1.2)` produced an all-transparent snapshot in Chrome 157. Its geometry rect was correct, but `drawElementImageToTexture` returned nothing.

Consequences:

- The drawer cannot slide with `transform: translateX(100%)`. It animates `right` from `-100%` to `0` instead.
- A glass element should not be inside a transform that is active while it needs a fresh snapshot.
- The page route transition still uses `transform` on `.page-view`. The glass chips already have a content snapshot, and the layer reads the page's computed opacity so they fade with the page instead of floating above it.

### 5.2 A fixed drawable element is empty

A probe with the drawable element itself at `position: fixed` produced an empty snapshot. The same element at `position: absolute` inside a fixed shell captured correctly. The drawer follows that structure:

```text
#cart-shell fixed
  aside absolute, drawable
```

### 5.3 The WebGPU context must exist

In a minimal probe, `drawElementImageToTexture` threw:

```text
containing canvas does not have a rendering context
```

The fix was to create and configure the WebGPU context before the paint handler uploads. `CanvasStage` calls `renderer.getContext()` during `init`, before the layer starts.

### 5.4 Do not put a background on the panel

The glass element must have a transparent computed background. A background colour would be part of the content snapshot, and the shader would composite an opaque rectangle over its own glass. The drawer uses `background: rgba(0, 0, 0, 0)`; the glass tint and shadow come from the shader.

### 5.5 The root and content textures need different usage

The root texture and the content textures are sampled with `TEXTURE_BINDING`. They are filled with `COPY_DST` and drawn with `RENDER_ATTACHMENT`. `COPY_SRC` is only needed by debug readback and is not part of the shipped texture usage.

### 5.6 three.js TSL type gaps

The published `@types/three` declarations for `vec2` ask for a `JoinNode` when both components are runtime nodes. The shader uses a small typed helper:

```ts
const joinVec2 = vec2 as unknown as (x: unknown, y: unknown) => ReturnType<typeof vec2>
```

The normal vector also needs one cast at the end of the SDF. These are type-surface gaps, not runtime behaviour.

### 5.7 Video does not invalidate the canvas by itself

`drawElementImageToTexture` copies the current DOM snapshot. A playing video changes pixels, but the stage still needs a paint event. `CanvasStage` watches `play`, `pause` and `ended` events with capture, keeps a set of playing videos and requests a paint on each animation frame while any video is playing. The showreel pauses itself with an `IntersectionObserver` when it is far offscreen.

### 5.8 Do not stack glass on glass

The drawer and the showreel cards can overlap in the page, but the drawer is drawn last and samples the root snapshot, which excludes both glass surfaces. The cards are therefore hidden under the drawer rather than refracted inside it. This is intentional. The page cards are also dimmed by the remaining brightness of the cart scrim, because their meshes are drawn after the root and would otherwise stay bright above the dimmed page.

The site header stayed as an opaque bar. Making it a glass surface would put the header above the shared product image and fly-to-bag clones, which currently live in the root snapshot. The clone would disappear under the header before it reached the bag icon. The drawer and the showreel demonstrate the material without breaking those transitions.

## 6. Measured numbers

All numbers are from Chrome 157 on this machine with a 1280 by 900 CSS viewport and DPR 2.

```text
canvas bitmap                 2560 x 1800
drawer content texture        832 x 1672   (416 x 836 CSS)
showreel card textures        544 x 331, 544 x 292
showreel pill texture         229 x 75
glass shader                  about 20 texture reads per fragment
                              17 blur taps + 3 chromatic backdrop samples
root upload                   every paint, 4.6M pixels
content uploads               only when dirty or on the first visible frames
```

The drawer slide trace measured `x = 1980` at the first paint and `x = 864` after about 360ms, so the `right` transition is driving the mesh and the DOM geometry together. The content snapshot did not change during the slide.

The glass content alpha bounds were checked directly from the GPU texture during development:

```text
showreel cards   8403, 740, 7808 non-empty pixels
cart with item   185317 non-empty pixels
```

Those counts confirm that the separate snapshot contains real text and controls, not just a background. They are debug numbers and are not exposed in production.

## 7. Verification

The final browser checks use Chrome 157 through CDP:

- Home at 1280 by 900 and 390 by 844, dark and light themes.
- Showreel scrolls into the sticky frame, the video plays, and all visible glass cards capture their text.
- Cart with an item, empty cart, checkout confirmation and Escape close.
- Drawer bounds, `drawable` attribute, transparent computed background and zero runtime errors.
- Light theme drawer uses a stronger cream tint and blur.
- Mobile hides the right card and the pill, leaving the left card as the glass demo.

Build checks:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 8. Files

| Path | Role |
| --- | --- |
| `src/stage/liquid-glass/options.ts` | Pure attribute parser and option signature. |
| `src/stage/liquid-glass/material.ts` | TSL glass material, uniforms, sampling and compositing. |
| `src/stage/liquid-glass/LiquidGlassLayer.ts` | Discovery, textures, meshes, anchors, dirty tracking and uploads. |
| `src/stage/CanvasStage.ts` | Starts the layer, passes the root texture, forwards paint changes and runs the video clock. |
| `src/components/cart/CartDrawer.vue` | Fully glass drawer, `right` slide, theme-specific tint. |
| `src/components/home/GlassShowcase.vue` | Video showreel and three glass surfaces. |
| `public/media/liquid-glass.mp4` | Nine second 720p showreel clip. |
| `tests/stage/liquid-glass-options.test.ts` | Parser tests. |

The showreel clip is a trimmed and compressed copy of the fish sample used by `liquid-glass-studio`. The original sample is credited there to Tom Fisk on Pexels.

## 9. Known limitations

- The blur is a single 17-tap kernel. Very large text behind the panel can remain faintly readable, especially in the light theme.
- The drawer top edge refracts the page header slightly. The tint and blur reduce it, but do not remove it.
- A glass element with a CSS transform cannot be re-captured reliably. Keep the transform on a non-drawable ancestor or animate layout properties instead.
- There is no glass-on-glass refraction. A glass surface samples the page snapshot, not the glass meshes behind it.
- The header is not glass. Making it glass would require moving the shared transition layer above the glass meshes or rendering that layer as another canvas overlay.
- The implementation depends on Chrome 157 behaviour for nested `drawable` snapshots, offscreen paint invalidation and `drawElementImageToTexture`. The support gate still rejects older browsers.
