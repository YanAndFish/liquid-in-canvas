# Apple Liquid Glass visual reference

<p align="center">
  <b>English</b> · <a href="APPLE_LIQUID_GLASS_REFERENCE.zh-CN.md">简体中文</a>
</p>

This project recreates the visual behavior of Liquid Glass with HTML-in-Canvas and WebGPU. Apple's official demos and iOS interface screenshots guide the visual target. `liquid-glass-studio` serves as a reference for signed distance fields, refraction, and multi-pass blur.

These notes distinguish Apple's descriptions, observations from screenshots, and renderer choices made in this project. The review of Apple's materials dates to November 7, 2026.

## iOS interface screenshots

These screenshots are from the iOS 26 edition of Apple's iPhone User Guide. They show complete screens, which makes them useful for comparing control proportions, contrast, and content layering. The images identify the major iOS version. The exact point release and accessibility settings are unknown. Apple owns the screenshots, and the images below are embedded from Apple's servers.

### Photos library and bottom navigation

[Get started with Photos on iPhone](https://support.apple.com/en-gb/guide/iphone/iphc259d0ac7/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/6c0c1af2cf439f969cee40af356f077a.png" width="280" alt="iOS 26 Photos library with Library, Collections, and a separate Search button at the bottom">

The photos stay sharp, and a visibly lighter surface backs the bottom navigation. A light fill marks the selected item within the shared material. A gap separates the Search button from the navigation group.

In the demo, product cards use standard content surfaces. The filters share a single pill, and a spring animates the selected background between items. The playback button and scene picker form a group.

### Photos Memories list

[Get started with Photos on iPhone](https://support.apple.com/en-gb/guide/iphone/iphc259d0ac7/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/61de8a3b3a33d86f531d0a6c4359eaa7.png" width="280" alt="iOS 26 Photos Memories screen with a large image and controls on a separate floating layer">

Images and text form a clear hierarchy. Glass is reserved for actions such as going back or playing a memory, leaving the main image visually intact.

The demo presents homepage imagery and text directly and uses glass for browsing, playback, and appearance controls. Material choices are grouped in the appearance menu.

### Safari start page

[Customize your Safari settings on iPhone](https://support.apple.com/en-gb/guide/iphone/iphb3100d149/26/ios/26)

<img src="https://help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/b9b877fe98989cc0fdb2b50bbe882bba.png" width="280" alt="iOS 26 Safari start page with a floating bottom search field and round action buttons">

The bottom search field picks up color from the backdrop while keeping its text sharp. The field and round buttons share a height and curvature. A separate layer distinguishes the controls from the content list.

The demo groups navigation controls by purpose and uses consistent corner radii and touch target sizes. Regular softens the backdrop and adds a theme tint. The shopping bag floats near the edge of the page with space around it.

## Official motion demo

The frame around 2:40 shows a narrow rim reflection. The examples from about 3:00 to 5:20 show a play button, press effects, sliders, and app controls. [Meet Liquid Glass, WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/)

- Refraction and lensing define the glass outline. Highlights can stay near the rim.
- Touch produces a local highlight and deformation.
- A menu expands from its trigger and takes on a thicker, softer material as it grows.

This project approximates these effects with rounded 3D volumes, narrow rim highlights, and press deformation. When a button expands into a menu, its width, height, blur, and tint change together. The refraction model and spring settings are specific to this project.

## Additional comparisons from November 14, 2026

Thirteen provided screenshots cover a pill over a two-color backdrop, round controls and a play button over sand dunes, three buttons over flowers, a menu expanding on a store page, and a toolbar over a grid. They show the following details.

- Refraction concentrates near the rim while the center stays flat. Sampling shifts inward near the edge, bending straight lines into curves that follow the outline. At the ends of the two-color pill, the dark region pulls inward into a rounded shape. The effect is visible on small buttons too.
- Clear glass shows very little blur. Frosted menus have stronger blur, a brighter backdrop, and more saturated colors. Shadows are faint.
- A pressed control enlarges and bulges into a thick lens. The leftmost of the three buttons shows an inverted image. Circular glass starts thick as it appears, then settles. Menu content magnifies and blurs as it expands from the trigger.
- A toolbar placed over a glass panel refracts the panel beneath it.

The renderer uses these observations to choose a refraction profile, adjust saturation and brightness, vary shadow strength, render stacked glass, and animate glass entering and leaving the page. The press effect uses a slight deformation. The rim highlight follows the directional model described below. See the [rendering notes](LIQUID_GLASS_NOTES.md) and the [measurement methods and data](performance/2026-11-14-visual/README.md).

## Real-device recording observations from November 27, 2026

A real-device iOS 26 screen recording (pulling the Lock Screen glass sheet over Safari on apple.com, showing the Safari bottom pill bar, Lock Screen flashlight/camera circular buttons, and the curved glass bevel sweeping across high-contrast text and buttons) revealed three concrete details:

- **Dual-axis rim specular and light-backdrop side contour**: Both round buttons and the Safari bottom bar show a crisp, narrow specular rim peaking along the top and bottom arcs (slightly tilted top-left / bottom-right) and fading along the sides. On dark backdrops, the rim lifts both white specular and the underlying refracted hue; on light backdrops, top and bottom stay pure white while the left and right arcs carry a delicate cool-gray grazing contour so glass edges stay crisp against white pages.
- **Chromatic dispersion inside the steep bevel**: High-contrast text, buttons, and color boundaries crossing the bevel show visible prismatic RGB separation (2–6 px), while quiet areas remain clean. Unifying the grazing-exit fallback across RGB channels eliminates the 1 px cyan artifact that previously forced default dispersion down to 0.05.
- **Luminous Regular material**: The Safari pill and circular buttons soften the backdrop while preserving color shapes and vibrancy rather than turning opaque.

The shared `glass_finish()` shader helper now implements the dual-axis rim specular, capped grazing Fresnel reflection, and light-backdrop side contour; unified RGB grazing fallback allows default dispersion to return to `0.14` (Regular) / `0.2` (Clear), and Regular defaults shift to `blur: 14`, `tintAlpha: 0.24 / 0.26`, and `saturation: 1.35`.

## Morphing content comparison from November 27, 2026 (WWDC25 05:06–05:50)

Frame-by-frame inspection of [Meet Liquid Glass, WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/) from 05:06 to 05:50 (button-to-menu expand/collapse, capsule toolbar ↔ vertical menu, button ↔ sheet, and the showcase rounded card ↔ vertical pill and `+` pulse) shows how glass shape changes affect foreground content:

- **Rounded silhouette clipping**: Throughout expansion, collapse, and cross-aspect morphing, foreground text and icons stay clipped to the live rounded glass outline rather than a sharp rectangle.
- **Bevel-rim refraction during motion**: While the glass is actively reshaping, content near the moving curved bevel bends and softens along the contour normal, flattening back to crisp typography as the glass settles.
- **Continuous outgoing content handoff**: Outgoing content does not vanish on frame 1; it blurs, compresses slightly with the contracting volume, bends along the shrinking rim, and fades out before the incoming content clarifies through the expanding glass.
- **Symmetric expand and collapse**: Both growing and shrinking/cross-morphing transitions drive blur, edge refraction, subtle volume swell, and rounded clipping from live deformation rather than expand-only reveal.

The renderer implements this in `content-shader.ts`, `content.hot.ts`, `LiquidGlassLayer.ts`, and `glass-frame.hot.ts` with rounded SDF clipping, bevel-normal edge warp, deformation-driven blur and swell, and `OutgoingContent` texture retention across handovers, `morph-to` merges, and significant same-element resizes. See `apps/demo/tests/visual/morph-content.html` for an interactive visual check page.

## Design and accessibility

Apple's materials guidelines distinguish Regular and Clear. The WWDC design session discusses grouping controls, using concentric corner radii, and handling scroll edges. [Materials, Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/materials) · [Get to know the new design system, WWDC25](https://developer.apple.com/videos/play/wwdc2025/356/)

- Persistent navigation and the shopping bag use Regular. Clear controls over media use a dark backing and white text.
- Control text comes from a separate HTML snapshot and stays sharp over the refracted backdrop.
- Users can pause video. It pauses offscreen, and autoplay is disabled by default when reduced motion is requested.
- With reduced motion enabled, menus and selection highlights jump directly to their destination.
- Escape closes the menu. Closed menu content uses `inert` and `aria-hidden`.
- CSS media queries handle reduced transparency and increased contrast.

## Implementation scope

The project supports 3D refraction through rounded glass volumes, wavelength-dependent dispersion, five levels of Gaussian blur, same-layer fusion, HTML content occlusion, screen-space reflections, press deformation, and menu size interpolation.

The renderer uses screen-space lighting and theme tint for the 3D Regular material. A full reproduction would also require the native environment lighting model, device orientation, semantic background recognition, and recursive refraction between layers. Check the actual GPU output separately from the browser capability check.

## Additional screenshot observations

Provided screenshots of the Dock, Control Center, Safari, and video demos show narrow light-to-dark transitions around the edge. A blue line in the background shifts as it passes through the glass. Nearby green can appear along parts of the rim that lie just outside the green region. Colored edges can come from the backdrop itself as well as from dispersion, so RGB separation explains only some of the observed color.

The 3D material approximates these effects with smoothly joined superellipse bevels, entry and exit ray intersections, and wavelength-specific refractive indices. The [liquid glass visual test](../apps/demo/tests/visual/liquid-glass.html) uses isolated color blocks as a fixed backdrop for comparing displacement and dispersion.

## 3D refraction and fusion experiments

The renderer uses a closed 3D signed distance field to find where light enters and exits the glass and how it refracts. It approximates the join between surfaces on the same layer with a smooth distance field. This model is specific to the project. It takes reflections from screen space and models fusion as a change in surface shape.

The top bar is a single strip of glass. The featured product label and add-to-bag button also participate in layer 0 fusion. HTML stacking order controls occlusion. Text covered by an upper piece of glass is drawn into its backdrop before blur is applied. The highlight stays tied to the lighting direction as the pointer moves, with most of its brightness concentrated in a narrow rim.
