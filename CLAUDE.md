# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

iOS-style liquid glass on the web, rendered with **HTML-in-Canvas + WebGPU**. A pnpm workspace:

```
packages/liquid-in-canvas   Publishable renderer library (no runtime deps, framework-agnostic)
apps/demo                   Vue 3 demo storefront "STILL" that consumes the library
tools/eslint-plugin-hot     Repo-internal ESLint plugin enforcing zero-allocation hot paths
docs                        Design notes, visual references, performance records
```

`docs/ARCHITECTURE.md` is the authoritative, detailed architecture reference (frame pipeline, GPU structure, resolution, render order, DOM contract). Read it before non-trivial changes to the renderer. README, docs and code comments are written in Chinese; follow that convention when editing them.

## Commands

Node `>=20.19`, pnpm `12.9.1` (pinned via `packageManager`).

```sh
pnpm install
pnpm dev            # demo dev server (Vite, default http://localhost:5173)
pnpm lint           # eslint . (antfu config); pnpm lint:fix to autofix
pnpm typecheck      # all packages (tsc / vue-tsc -b)
pnpm test           # vitest run in every package
pnpm build          # library (packages/liquid-in-canvas/dist) then demo
pnpm build:lib      # library only
```

CI runs `lint → typecheck → test → build` on Node 22.

Single package / single test:

```sh
pnpm --filter liquid-in-canvas test
pnpm --filter @liquid-in-canvas/demo test
pnpm --filter @liquid-in-canvas/eslint-plugin-hot test
pnpm --filter liquid-in-canvas exec vitest run tests/stage/flow.test.ts
pnpm --filter liquid-in-canvas exec vitest run -t "test name substring"
```

Perf/visual harness (run from `apps/demo`): `pnpm exec vite build --config tests/perf/vite.config.ts --outDir <dir> --emptyOutDir`, copy the desired entry (`tests/perf/index.html` or `scroll.html`) to `<dir>/index.html`, then `pnpm exec vite preview --outDir <dir>`. See `docs/performance/*/README.md` for full procedures and the `summarize*.py` scripts.

Publishing must use `pnpm publish`: the library's `exports` point at `src/` for in-repo use, and only pnpm swaps in `publishConfig.exports` (pointing at `dist`). The demo consumes library source directly, so no library build is needed during development.

## Architecture essentials

### Library entry points and rendering modes

- `liquid-in-canvas` (`src/index.ts`): public API. It must **not** statically import the canvas renderer; `mountLiquidGlass()` (`src/mount.ts`) dynamically imports `CanvasStage` only after capability checks pass, so fallback-only browsers never download it.
- `liquid-in-canvas/canvas` exports `CanvasStage` directly (used by perf/visual pages only).
- `liquid-in-canvas/motion` exports springs and reduced-motion queries.
- `liquid-in-canvas/vue` / `liquid-in-canvas/react` are type-only (`src/vue.d.ts`, `src/react.d.ts`, copied to `dist` by the build): they add `LiquidGlassAttributes` (`src/attributes.ts`) to the framework's native element attributes. When adding a `data-*` hook or glass option, also add it to `LiquidGlassAttributes`; `tests/types/attributes.test.ts` fails typecheck if the two drift.

`mountLiquidGlass({ root, mode })` picks one of three implementations that all read the same `data-glass-*` attributes, the same global defaults (`liquid-glass/defaults.ts`, `setGlassDefaults()`), and the same theme source (`liquid-glass/theme.ts`):
- `canvas` — `CanvasStage`: moves the root into a `<canvas content="drawable">`, full effects (refraction, lens, dispersion, fusion, occlusion, press deformation, liquid morph).
- `svg` — `CssGlassStage` + SVG displacement filter (`css/refraction.ts`), Chromium only.
- `css` — `CssGlassStage`, plain `backdrop-filter`.
`auto` tries canvas → svg → css and falls back on init/runtime faults via `onFault`.

### DOM contract

The stage knows the page only through attributes registered in `src/contract.ts` (`data-liquid-glass`, `data-glass-clip`, `data-glass-modal`, `data-glass-scrim`, `data-glass-fade`, `data-stage-overlay`). When adding or changing a hook, update `contract.ts` **and** the DOM contract table in `docs/ARCHITECTURE.md`. Glass parameters are parsed in `liquid-glass/options.ts` (attribute first, then global default).

Render order ranges live in `src/render-order.ts` (page = 0, glass layer L at `900 + 10·L …`, overlays at `900 + 10·L − 0.5`); `tests/stage/render-order.test.ts` asserts the ranges don't overlap. The demo uses layer 0 for nav/page glass, 1 for the tuner panel, 10 for the cart drawer, overlay at 5.

### Canvas frame pipeline

No persistent RAF loop: the browser `paint` event drives a frame; continuous redraw is requested only while video plays, springs move, or liquid morph is in flight. Per frame (`stage-frame.hot.ts`): page snapshot → glass surface sync (`LiquidGlassLayer`) → content occlusion (`content-order`, `ContentBackdrop`) → multi-level Gaussian blur (`blur`) → 3D SDF volume groups with same-layer fusion (`VolumeGroups`, `volume-shader.ts`) → overlay (`CanvasOverlay`) → canvas pass. All in one command buffer.

GPU (`gpu.ts`): raw WebGPU, no scene graph. Every draw is "one rect + one uniform slice"; vertices are generated from the uniform (no vertex buffers); all uniforms for a frame are packed into one buffer with dynamic offsets; pipelines are cached in `PipelineTable` keyed by integer (volume member count, occluder count). Snapshots are `rgba8unorm-srgb`, offscreen targets linear `rgba16float`.

Canvas pixel ratio (text sharpness; `maxPixelRatio`, `maxPixels`) and glass-shading pixel ratio (`maxGlassPixelRatio`, plus adaptive downscale in `adaptive.hot.ts`) are controlled separately (`resolution.ts`).

### Hot-path rule (`*.hot.ts`)

Files named `*.hot.ts` contain code that runs every frame during scroll/animation and **must not allocate heap memory**. `tools/eslint-plugin-hot` enforces this (`hot/no-alloc`, `hot/no-closure`): no `new`, object/array literals, spread, closures/callbacks, template strings with interpolation, string concat, `async`, or allocating methods like `map`/`filter`/`slice`/`sort` (use insertion sort). Constructors, class fields and module top level are exempt.

- Put allocations (pool growth, cache misses, texture resize) in cold-path sibling files (`frame.ts`, `liquid-glass/pools.ts`, `surface.ts`, `*-shader.ts`, `LiquidGlassLayer.ts`) and call them only in rare cases.
- Read each DOM rect/style at most once per element per frame (cached by frame number in `ElementBox`); prefer `checkVisibility()`.
- Exceptions require `// eslint-disable-next-line hot/no-alloc -- <reason>` (descriptions are mandatory in hot files).

### Demo app

- `src/main.ts` checks capabilities and mounts with `mode: 'canvas'` (not `auto`); on unsupported/fault it shows `UnsupportedView`, whose button remounts with `svg` (library degrades to `css` if needed).
- `composables/useRenderer.ts` (`RendererController`, provided to the tuner) switches modes/resolution while the app stays mounted, restoring scroll position and video playback after the root moves.
- The demo imports only from `liquid-in-canvas` and `liquid-in-canvas/motion` (plus `liquid-in-canvas/vue` in tsconfig `types`) — never library internals (perf/visual pages are the exception).
- Demo-only DOM conventions outside the stage contract: `#stage-scroll` (the single scroll container; `window` doesn't scroll in canvas mode), `[data-product-image]` (shared-element transitions), `[data-bag-target]` (add-to-bag animation target).
- UnoCSS (`apps/demo/uno.config.ts`), `@` alias → `apps/demo/src`.

## Testing notes

- Vitest + jsdom everywhere. Library GPU-side logic (pipeline cache, uniform layout, draw lists, per-frame glass layer) is tested by driving real code against a recording fake device in `packages/liquid-in-canvas/tests/helpers/fake-gpu.ts`.
- jsdom does not render WebGPU: passing tests do not validate shader output. Visual changes must be checked in a browser that supports HTML-in-Canvas, WebGPU and `GPUQueue.drawElementImageToTexture()` (development targets Chrome 157). Manual check pages: `apps/demo/tests/visual/*.html`.

## Conventions

- Conventional commits (`feat:`, `fix(scope):`, `perf(rendering):`, `refactor(stage):`).
- Large panels should sit on their own glass layer to avoid fusing with controls beneath (fusion cost scales with group members per pixel).
