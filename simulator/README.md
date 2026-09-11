# RFQ economic simulator

The Python models exercise the architecture's economic and recovery invariants. They are not a profitability backtest or production pricing engine.

Run:

```bash
cd simulator
python3 -B -m unittest discover -v
```

Covered now: integer USDC/rate arithmetic; exact cumulative split invariance; cross-wallet reservations; conservative pending offsets; current-state stale-quote rejection; correlated impact; portfolio stress caps; distinct signer quorum; nonce/expiry replay; epoch failover; margin tiers; positive-uPnL restrictions; funding conservation; liquidation progress; loss waterfall; pro-rata resolution; oracle modes; historical replay parsing; and service-fault drills.

`walk_forward_calibration.py` calibrates risk-component weights on purged chronological train, validation and untouched holdout partitions. It removes observations whose forward label crosses a boundary, selects against the worst validation regime, and reports current-model comparison plus tail shortfall.

`flow_calibration_lab.py` converts the normalized Coinbase/Binance tape captured by `npm run capture:market-flow` into causal volatility, trailing-flow imbalance, fresh venue-basis, hedge-friction and forward-markout observations. It runs deterministic 5%, 25%, 50% and 90% toxicity mixtures and generates JSON plus a private HTML report. This is a stress laboratory, not a substitute for paid RFQ flow or an automatic parameter deployment path. See `MARKET-FLOW-CALIBRATION.md`.

`adversarial_scenarios.py` isolates Sybil order splitting, parallel reservation bursts, stale and divergent oracle inputs, volatility-sensitive latency, hedge outages and guarded capacity. `market_making_scenarios.py` runs the connected quote and hedge policy through calm, trend, high-volatility, toxic-burst, gap-up, crash and hedge-outage environments. Both are deterministic policy laboratories rather than profit forecasts; contract equivalence remains in the fixed-point and Solidity suites.

`fixed_point.py` is the integer reference used to keep Python and Solidity units aligned. `state_machine.py` models admission through settlement and recovery. `fault_harness.py` drills one signer offline, one key compromised, API failure after quorum, sponsor depletion and ambiguous hedge acknowledgement.

Historical data:

```bash
python3 -B fetch_coinbase_candles.py --start 2025-09-01T00:00:00Z --end 2026-09-01T00:00:00Z --granularity 3600
python3 -B historical_replay.py --btc data/BTC-USD_3600_1756684800_1788220800.csv --eth data/ETH-USD_3600_1756684800_1788220800.csv
```

The included Coinbase data has 8,751 paired hourly candles per market and two timestamp gaps per file. The downloader preserves gaps. The replay uses common timestamps and close-to-close changes; it does not fabricate missing data. At the default synthetic customer book of +$250k BTC and +$250k ETH and one-hour hedge delay, maximum observed loss was $24,611.07 and p99 loss was $7,667.57. This cannot measure intrabar moves, subsecond quote latency, venue basis/depth or actual customer order flow.

Next model layers: actual RFQ response curves; joined paid-fill markouts; a third independent venue; actual hedge fills and depth; liquidation races; multi-day funding paths; and USDC deviations.
