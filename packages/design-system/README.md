# Design system

The shared look of every RFQ Markets surface. The full reference (principles,
components, screens, flows and the rollout plan) is the published design
system: https://claude.ai/artifact/CJRW4HX7NGNEmwYCb3aLU7

| File | What it holds |
| --- | --- |
| `tokens.json` | The source of truth: colors for the dark and light themes, type, spacing, radius, shadows and sizes. |
| `tokens.css` | Generated from `tokens.json` by `npm run build:tokens`. CI fails if it is stale (`npm run check:tokens`). |
| `components.css` | Component classes prefixed `rfq-` (buttons, side toggle, amount input, sheets, toasts, tables…). |
| `legacy.css` | Old token names mapped onto the new ones for apps that have not been rebuilt yet. |

Apps import `tokens.css` and `components.css`, and the Geist fonts from
`@fontsource-variable/geist` and `@fontsource/geist-mono` (the apps' CSP only
allows self-hosted fonts). Without a `data-theme` attribute the page follows
the system light or dark setting; `data-theme="dark"` or `"light"` pins it.
Never put hex values in app CSS: add a token here first.
