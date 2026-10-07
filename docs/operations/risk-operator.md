# Risk operator and the market console

Status: contract v1.2, 2026-10. Live deployments get it with the next upgrade; until then the console shows
their markets read-only.

Listing a market and changing its risk settings is an operations job that must not wait on the 72-hour
governance timelock. The **risk operator** is a contract role for it: one address, appointed by governance,
that changes markets at once, with no timelock, inside an envelope governance sets.

## What each role may do

| Change | Governance | Risk operator | Emergency council |
| --- | --- | --- | --- |
| List a market (`addMarket`) | Yes | Within the envelope | No |
| Reduce-only and reopen (`setMarketPolicy` enabled flag) | Yes | Yes | Reduce-only only |
| Max trade and net cap (`setMarketPolicy`) | Yes | Lower freely; raise up to the envelope | Lower only |
| Gross and per-side caps (`setExposurePolicy`) | Yes | Lower freely; raise gross up to the envelope | Lower only |
| Margin multiplier, stress shock, impact K (`setMarketRisk`) | Yes | Raise freely; lower down to the envelope's floors | No |
| Base spread, per market or default (`setSpread`) | Yes | Yes, 2 to 50 bps | No |
| Appoint the operator (`setRiskOperator`) | Yes | No | Revoke only (set zero) |
| Set the envelope (`setRiskOperatorBounds`) | Yes | No | No |

The contract's absolute limits bind everyone: 1,000,000 USDC per trade, 5,000,000 USDC net and gross per market,
margin from 0.25x to 5x the base tiers (20x to 1x first-tier leverage), stress shock from 5% to 100%.

The operator cannot move funds, pause or unpause, upgrade, rotate approvers, change the oracle or touch
governance. A compromised operator key can at worst open markets up to the envelope and narrow spreads to 2 bps;
two of three approvers still sign every fill, and the emergency council or governance can revoke the key in one
transaction.

The rules live in `contracts/libraries/RFQMarketAdmin.sol`, a linked library, and are tested in
`test/contracts/RiskOperator.t.sol`.

## The envelope

`RiskOperatorBounds` holds three ceilings (max trade, net cap, gross cap) and three floors (impact K, stress
shock, margin multiplier). A change that tightens is always allowed, even when the current value sits outside
the envelope; a change that loosens must land inside it. All zero lets the operator tighten and nothing else.

Suggested production envelope, to be confirmed with the risk review: max trade 250,000 USDC, net cap
1,000,000 USDC, gross cap 2,000,000 USDC, margin multiplier at least 5,000 (10x), stress shock at least 30%,
impact K at least the BTC value (10,000).

## Spreads

Each market has a base spread on chain (`marketSpread(id)`, zero means the default) and there is a default
(`defaultSpread()`, zero means the services' built-in 2 bps). The API uses it as the base component of the
adaptive spread; volatility, toxicity, hedge and basis components still add on top, capped at 100 bps. Approvers
reject a quote whose base component is below the market's. Services reload the registry every minute
(`RFQ_MARKET_REFRESH_MS`), so a raised spread can cause a minute of rejected quotes on approvers that refreshed
first. Spread changes do not bump `policyVersion`.

Exposure caps can now change while the venue is live. The policy version bump fences approvals priced against
the old caps, and a book already over a lowered cap may still shrink.

## The console

`admin.rfq-markets.workers.dev`, view **Markets and risk** (`#markets`), behind Cloudflare Access. It reads the
chain and clearing address from `GET /v1/config` and everything else from the contract through the operator's
wallet. Each change is reviewed (from and to, with values that add risk highlighted), simulated as the
operator, and then signed by the operator's own wallet in the browser. No server holds a key that can change
a market. The page explains a refusal (wrong role, outside the envelope) before the wallet is asked to sign.

Locally, `npm run dev:stack` appoints a funded risk operator with the contract's own limits as its envelope,
and `npm run dev:admin` offers **Use local operator** (development builds only).

## Turning it on for a live deployment

1. Upgrade the clearing (the new `RFQMarketAdmin` library and implementation). On the dev deployment that is
   `npm run dev-upgrade:base-mainnet`; in production it goes through the timelock.
2. Governance calls `setRiskOperatorBounds(...)` with the agreed envelope, then `setRiskOperator(address)`. On
   the dev deployment `npm run dev-risk-operator:base-mainnet -- DEV_MANIFEST OPERATOR_ADDRESS` does both with
   the dev ceilings as the envelope. In production both go through the timelock once; after that the operator
   acts at once.
3. Optionally set spreads with `setSpread(market, bps)` and `setSpread(255, bps)` for the default.

Use a hardware wallet or a Safe owner key for the operator. To rotate it, governance appoints the new address;
to stop it, governance or the emergency council calls `setRiskOperator(0x0)`.
