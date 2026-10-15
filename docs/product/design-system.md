# Product design system

The design system lives in [`packages/design-system`](../../packages/design-system/README.md). `tokens.json` is the source of truth for color, type, spacing, radius, shadows and sizes; `npm run build:tokens` generates `tokens.css` and `colors.ts` from it, and CI fails when either is stale. `components.css` holds the shared `rfq-` component classes.

Tick, the mascot, is the logo. It is a blue character whose antenna is an arrow: green and pointing up when idle or winning, red and pointing down when losing. `mascot.json` holds the drawing; `npm run build:tokens` writes `logo.svg` and every app's favicon from it. Tick sits next to the name in each app's top bar, cheers or sweats on the share card depending on the result, and stands in for the icon in empty states (idle when there is nothing yet, losing when something is unavailable or not found).

The specimen page renders all of it straight from those files, so it cannot drift: run `npm run dev:design-system` and open `http://127.0.0.1:4177`. It shows every color token in both themes with its usage note, every type style, the spacing and radius scales, and the shared components.

## Look

- **One brand color.** `brand` (#3D6BF5 in dark) marks primary actions, the active nav item and selected chips. The logo, the favicons and the share card use the same value.
- **Up and Down.** `long` is green for Up, gains and healthy state; `short` is red for Down, losses and danger. Neither is used for anything else, and every state also says what it is in words.
- **Neutral surfaces.** `bg`, `surface`, `surface-raised` and `surface-sunken` layer the page in both themes. The page follows the system theme unless the person picks one.
- **Type.** Geist for everything, with tabular figures for numbers. Geist Mono only for addresses, hashes and other machine identifiers. Both are bundled; no font is fetched from a third party.
- **No hex values in app code.** A new color is a token first. Code that draws outside CSS, such as the share card's canvas, imports `colors.ts`.

## Product rules

1. Home is the product for most people: a market, an amount, a multiplier and two buttons. Everything else (order types, slippage, close only, candles) lives in Pro, one tap away.
2. Say it the way a person would: trade, amount, Up, Down, Cash out. No "bet", "stake", "notional" or "reduce-only" on Home.
3. Show the price someone will get and what happens if it moves against them: the auto-close price and about how much they would lose there. Never label an indicative price as firm.
4. There are no trading fees, so there are no fee rows. The spread is the price.
5. Defaults must be safe and enough for a first trade. One tap is offered on the first trade's confirm step, with its limits stated.
6. Every loading, delayed, paused, closing-only, rejected and pending state has explicit text, not just a color.
7. Public data may show aggregate exposure. Hedge state, venue orders, thresholds and failures stay private.
8. Layouts work at 390px wide with no horizontal scroll; the browser suite checks every app on a phone viewport.
