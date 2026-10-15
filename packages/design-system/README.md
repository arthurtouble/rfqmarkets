# Design system

The shared look of every RFQ Markets surface. `tokens.json` is the source of
truth; everything else is generated from it or built on it. The specimen page
(`npm run dev:design-system`) renders the tokens and components straight from
these files, and `docs/product/design-system.md` holds the written guidance. The
longer reference (principles, screens and flows) is the published design
system: https://claude.ai/artifact/CJRW4HX7NGNEmwYCb3aLU7

| File | What it holds |
| --- | --- |
| `tokens.json` | Colors for the dark and light themes, type, spacing, radius, shadows and sizes, each with a usage note. |
| `tokens.css` | Generated from `tokens.json` by `npm run build:tokens`. CI fails if it is stale (`npm run check:tokens`). |
| `colors.ts` | Generated with `tokens.css`: the resolved colors per theme, for code that draws outside CSS, such as the share card. |
| `components.css` | Component classes prefixed `rfq-` (buttons, side toggle, amount input, sheets, toasts, tables…). |
| `mascot.json` | Tick, the mascot and logo, on a 64 × 64 grid: shared shapes plus one set per mood (`idle`, `win`, `loss`), colored by token name. |
| `mascot.ts` | Tick as SVG markup (`mascotSvg`) or canvas paths (`drawMascot`), for the share card and the specimen. |
| `react.ts` | The `Mascot` React component every app's top bar and empty states use. |
| `logo.svg` | Idle Tick, generated from `mascot.json` by `npm run build:tokens`, which also writes every app's favicon. |

Apps import `tokens.css` and `components.css`, and the Geist fonts from
`@fontsource-variable/geist` and `@fontsource/geist-mono` (the apps' CSP only
allows self-hosted fonts). Without a `data-theme` attribute the page follows
the system light or dark setting; `data-theme="dark"` or `"light"` pins it.
Never put hex values in app code: add a token here first. Never copy Tick's
drawing either: change `mascot.json` and run `npm run build:tokens`.
