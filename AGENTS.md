# RFQ Markets agent guide

## Environment

- Use `npm ci` for a reproducible install from `package-lock.json`. GitHub CI
  runs Node.js 24; the Codex cloud environment uses Node.js 22, the newest
  version currently offered by its universal image. Keep changes compatible
  with both and treat CI on Node.js 24 as the release baseline.
- Python 3 is required for the simulator tests. The standard test suite does not
  require the optional Hyperliquid SDK.
- Foundry (`forge`) is required for the Solidity tests. Initialise
  `lib/forge-std` with `git submodule update --init --recursive`.
- Install `services/hedger/requirements.txt` only when working on the live or
  testnet Hyperliquid integration.
- Treat `.local-state/`, `.env*`, private keys, RPC credentials, and deployment
  manifests as local or secret state. Never commit them.

## Validation

- Run `npm run typecheck` after TypeScript changes.
- Run `npm run test:foundry` after contract changes, then
  `npm run test:contracts` for the compile gate and local-chain e2e suites.
- Run `npm run test:services` for service and script unit tests and
  `npm run test:web` for trading app logic. `npm run test:coverage` runs them
  with a per-area coverage summary.
- Run `npm run test:e2e` after UI changes. It drives every app on desktop and
  phone viewports against the local stack; see `test/e2e/README.md`.
- Run `npm run test:python` for simulator changes.
- Run `npm run test:cloudflare-edge` for Cloudflare edge/runtime changes.
- Run `npm run check:docs` after moving or renaming Markdown files.
- Run the narrowest relevant test first, then `npm test` before declaring a
  cross-cutting or release-sensitive change complete.

## Safety boundaries

- Do not deploy, upgrade contracts, fund accounts, publish images, or run live
  Base Sepolia/Hyperliquid smoke tests unless the task explicitly requests it.
- Do not weaken signature, quorum, replay, oracle-freshness, exposure, or
  fail-closed checks to make a test pass.
- Preserve unrelated working-tree changes. The repository may contain active
  local experiments.
- Use the local Hardhat path for integration work unless an external network is
  explicitly required.

## Architecture pointers

- Start with `README.md`, `docs/README.md`, `docs/architecture/overview.md`
  and `docs/operations/local-development.md`.
- Cloudflare deployment details live in `docs/operations/cloudflare.md` and
  `deploy/cloudflare/`.
- Production readiness and unresolved controls are tracked in
  `docs/release/implementation-plan.md` and `docs/release/release-checklist.md`.
- `docs/history/` is superseded material; current docs win where they differ.
