# Market-flow calibration laboratory

Status: executable research pipeline. It never changes live or testnet quoting parameters automatically.

## What it measures

The lab records public BTC and ETH trade/BBO events from Coinbase Exchange and Binance, normalizes maker/taker direction, removes duplicate venue trade identities, and aggregates same-side bursts into 250-millisecond volume-weighted buckets. It then creates deterministic RFQ-flow scenarios with 5%, 25%, 50%, and 90% toxic-flow mixtures and synthetic RFQ notionals from 100 to 250,000 USDC.

Every feature is causal. Volatility uses only observations already received. The flow-imbalance proxy uses only the trailing 30-second public tape. Venue basis uses prices observed within the preceding two seconds. Forward prices appear only in the 1-second, 5-second, 30-second, and 5-minute adverse-markout labels.

Public taker flow is deliberately treated as a stress covariate rather than a model of our users. It cannot reveal our future quote-to-fill curve, customer selection behavior, or production hedge slippage. Those require our own paid RFQ fills and venue execution records. The synthetic mixture makes assumptions visible and lets the same tape test benign, mixed, and strongly informed flow.

## Leakage and poisoning controls

- Train, validation, and untouched holdout partitions are chronological.
- Observations are purged when their forward-label horizon crosses a partition boundary.
- Candidate weights are selected on train and validation only. Holdout is reported after selection.
- Validation minimizes the worst scenario loss before aggregate loss.
- Underquoting is penalized 24 times as heavily as one basis point of excess spread.
- Every report records the raw tape SHA-256, venues, markets, horizons, seed, duration, and sample counts.
- The capturer tracks trade IDs independently for every venue and market. Missing IDs or reported WebSocket transport failures invalidate the dataset until the missing range is backfilled and the summary is regenerated.
- No candidate may enter shadow mode unless the tape spans at least 24 hours, contains both markets, contains at least 10,000 trades from at least two venues, includes a five-minute label, has a clean capture-integrity summary, and beats the current model without exceeding a 5% holdout underquote rate.
- Shadow eligibility permits observation only. Price activation requires multiple non-overlapping periods, stable parameters, real RFQ markouts, measured hedge fills, risk approval, and a new explicit model version.

Two public venues do not form an oracle quorum. The settlement price remains the on-chain-verifiable Pyth observation. Venue disagreement widens the research basis feature; it never replaces settlement truth. Add a third independent market venue before using cross-venue reference estimates for production detection.

## Run it

Capture a short plumbing sample:

```bash
npm run capture:market-flow -- --seconds 300 --output .local-state/market-flow/current.csv
npm run calibrate:market-flow -- ../.local-state/market-flow/current.csv \
  --horizons-ms 1000,5000 \
  --output ../.local-state/calibration/latest.json \
  --observations ../.local-state/calibration/observations.csv
```

Run a qualifying research capture for at least 24 hours and retain all four label horizons:

```bash
npm run capture:market-flow -- --seconds 86400 --output .local-state/market-flow/day-01.csv
npm run calibrate:market-flow -- ../.local-state/market-flow/day-01.csv \
  --horizons-ms 1000,5000,30000,300000 \
  --output ../.local-state/calibration/day-01.json \
  --observations ../.local-state/calibration/day-01-observations.csv
```

The capturer reconnects with bounded exponential backoff, writes in bounded batches, and reports per-venue counts, sequence gaps, and transport failures. It refuses to overwrite or append to a nonempty tape so one integrity summary always describes exactly one immutable capture. Rotate files daily and hash each source file before archiving it. A production recorder should backfill Coinbase gaps from its product-trades REST endpoint and retain a second raw journal; this first version deliberately fails qualification instead of guessing across a gap.

The generated HTML report sits beside the JSON output. For the default path:

```bash
python3 -m http.server 4180 --bind 127.0.0.1 --directory .local-state/calibration
```

Open `http://127.0.0.1:4180/latest.html`. Keep this dashboard private because future reports will contain maker economics.

## Promotion process

1. Collect several non-overlapping periods covering calm, trend, announcements, jumps, thin books, venue divergence, outages, and funding transitions.
2. Run the fixed calibration seed plus sensitivity seeds. Reject unstable weights.
3. Join our real testnet RFQ fills to 1-second, 5-second, 30-second, and 5-minute markouts. Keep rejected quotes so fill probability and user-price rejection can be measured without survivor bias.
4. Join actual Hyperliquid acknowledgements, partial fills, fees, sweep cost, basis, and residual-exposure time. Calibrate hedge bands and slice sizes separately from customer spread.
5. Compare the candidate with the active model in shadow mode. Require lower adverse shortfall and equal or better expected net value without materially reducing ordinary-flow acceptance.
6. Reproduce the chosen inputs in independent approvers through an authenticated append-only model-input log or conservative approver envelopes.
7. Assign a new model and policy version, run the full economic/fault suite and a sustained testnet soak, then activate under capped limits.

The most useful next quantitative addition is an RFQ response model fitted from our own data: probability of signing as a function of market, side, size, quoted spread, price movement during signing, wallet latency, and rejection history. Until that exists, optimizing quoted spread for “profit” would use an invented demand curve and produce false precision.
