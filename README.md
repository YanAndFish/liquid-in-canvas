# STILL

A storefront built as a test bench for Apple's Liquid Glass effect over live HTML rendered into canvas. This is stage 01: the storefront foundation. The canvas host and the refraction shader are not built yet.

The store sells twelve home and daily objects. It ships in English and Simplified Chinese, with dark and light themes. It has category filters, product detail pages, a cart that survives reload, and a demo checkout. Product photography was generated for this storefront and stored as WebP under `public/products/`.

![STILL storefront in the light theme](docs/preview.webp)

## Run it

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173.

## Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Start the Vite dev server. |
| `pnpm build` | Type-check and build to `dist/`. |
| `pnpm test` | Run the Vitest suite. |
| `pnpm lint` | Run ESLint with `@antfu/eslint-config`. |
| `pnpm typecheck` | Run `vue-tsc` only. |

## Routes

| Route | Shows |
| --- | --- |
| `/` | Hero, collection filters, product grid, and the approach section. |
| `/product/:slug` | Product detail with copy, specs, add to bag, and three related objects. |
| Any other path | A not found page. |

## Structure

`src/pages/` holds the route views: `HomeView`, `ProductView`, and `NotFoundView`.

`src/components/` is grouped by feature. `layout/` holds the header and footer. `home/` holds the hero, collection, filter, and approach. `product/` holds the card and grid. `cart/` holds the drawer and line row. `ui/` holds shared icons.

`src/router/` exports the route table and the browser router. `routes.ts` is separate so tests can build a memory router from the same table.

`src/stores/cart.ts` is the cart store. It exposes readonly state, derived lines and totals, and the actions `add`, `increment`, `decrement`, `remove`, and `clear`. `createCartStore` is provided through `CART_KEY`, so components call `useCart()` and no state library is needed.

`src/domain/` holds the catalog, money helpers, cart selectors, and the localStorage boundary. Product names, descriptions, details, and specs are `LocalizedText`, so every object carries English and Simplified Chinese copy. The cart state stores product ids and quantities only. Prices are joined from the catalog when the UI reads the cart, so a price change cannot leave stale copies behind.

`src/i18n/messages.ts` is the typed message dictionary. `translate()` replaces named parameters. The locale follows the browser on first load, persists under `still.locale`, and updates `<html lang>`, the document title, and the meta description.

`src/styles/main.css` defines the palette as CSS variables on `html`. `useTheme()` writes `data-theme` on the same element, persists the choice under `still.theme`, and updates the browser theme color. The first paint reads the stored theme from a small inline script in `index.html`, so the page does not flash the wrong palette.

`tests/` holds every test, split into `domain/`, `stores/`, `i18n/`, and `app/`. Colocated test files are gone.

## Cart model

`CartState` is an ordered list of `{ productId, quantity }`. The store keeps one line per product, preserves first-add order, clamps quantity to 99, and removes a line when its quantity drops below one. Shipping is free from $150, otherwise it is a flat $12.

The cart persists under `still.cart.v1`. Reads validate every line: unknown ids, non-integer quantities, and zero quantities are dropped, and duplicate ids are merged. A failed read or write leaves the app working.

## Stack

Vite 8, Vue 3.5, Vue Router 5, TypeScript 6, UnoCSS, Vitest with jsdom, ESLint with `@antfu/eslint-config`, and pnpm. CI runs lint, typecheck, test, and build on every push and pull request.

## Not built yet

The next stage wraps the collection stage in `<canvas layoutsubtree>`, captures it with `drawElementImage()`, and draws a WebGL glass layer over the live texture. That path needs Chrome 157 or later, where HTML-in-Canvas is on by default.
