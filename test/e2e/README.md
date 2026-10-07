# End-to-end tests

Playwright specs that drive the browser apps against the local stack: a Hardhat
chain with the contracts deployed, every service, simulated prices and the
apps' Vite dev servers. Each spec runs twice, in a `desktop` project
(1440×900) and a `mobile` project (Pixel 7: 412×915, touch). The emergency exit
spec moves chain time forward, which the shared Hardhat chain cannot undo, so it
runs last in its own `exit desktop` and `exit mobile` projects.

```
npm run test:e2e                       # starts the stack if it is not running
npm run test:e2e -- --project=mobile   # one viewport
npm run test:e2e -- trading            # specs whose file name matches
npm run test:e2e:ui                    # Playwright's interactive runner
npx playwright show-report             # last HTML report
```

Outside CI an already running stack is reused, so keep
`npm run dev:stack -- --web --mine-every-second` open in another terminal while
iterating. The flag mines a block once a second, as Base does; with automine each
transaction gets its own later second, and a long run pushes chain time far
enough ahead of the wall clock that oracle reports look stale. The
docs site (`npm run dev:docs`) is started the same way.

In a cloud session the pre-installed Chromium may not match this Playwright
release; point the tests at it with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`. CI installs the
matching browser with `npx playwright install --with-deps chromium`.

## Writing specs

- One file per feature, named after it: `wallet-connect.spec.ts`,
  `funds.spec.ts`, `trading.spec.ts`, `orders.spec.ts`, `portfolio.spec.ts`,
  `markets.spec.ts`, `exit.spec.ts`, `admin.spec.ts`, `terms.spec.ts`. `smoke.spec.ts` only
  checks that every page loads and fits the screen.
- Import `test` and `expect` from `./fixtures.js`. Every test then fails on an
  uncaught page error, and console errors are attached to the report.
- Fixtures: `stack` (URLs, `devWallet()`, `prices()`, `setPrice(market, price)`),
  `isMobile`, and `acceptTerms`, which marks the dev wallet as having accepted
  the terms so the dialog stays out of the way. Turn it off with
  `test.use({ acceptTerms: false })` to test the dialog itself. Branch on `isMobile` only where the layout differs, for
  example the bottom tab bar or the ticket opening as a sheet.
- `expectNoHorizontalOverflow(page)` fails when a page scrolls sideways and
  names the widest elements. Call it on every screen and open dialog.
- Select by role and accessible name (`getByRole("button", { name: "Long" })`),
  never by CSS class. If an element has no accessible name, add one in the app.
- The chain is shared and specs run one at a time. Do not assume an empty
  account: read the starting state, act, then assert on the change. Dev builds
  auto-connect the funded key from `GET /v1/dev/wallet`.
- Prices move on their own. When a test needs a fixed price, call
  `stack.setPrice` first and wait for the UI to show it.

Unit tests still own the logic (`npm run test:web`, `npm run test:services`).
Use end-to-end specs for what only a browser shows: the flow works, the screen
is laid out correctly, and errors reach the user.
