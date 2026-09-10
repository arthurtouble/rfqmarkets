#!/usr/bin/env python3
"""Replay synthetic customer books against paired BTC/ETH candle histories.

This is a market-risk and hedge-latency harness, not a backtest of profitability:
there is no historical customer order-flow dataset. It reports adverse one-bar
and delayed-hedge losses for explicit synthetic exposures.
"""

import argparse
import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class ReplayResult:
    observations: int
    max_portfolio_loss: float
    max_portfolio_loss_time: str
    max_btc_abs_return_bps: float
    max_eth_abs_return_bps: float
    p99_portfolio_loss: float
    loss_over_150k_count: int
    max_hedge_delay_loss: float
    hedge_delay_bars: int


def load(path: Path) -> dict[int, dict[str, float | str]]:
    with path.open(newline="") as handle:
        return {int(row["time"]): row for row in csv.DictReader(handle)}


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    return values[min(len(values) - 1, int((len(values) - 1) * quantile))]


def replay(
    btc: dict[int, dict[str, float | str]],
    eth: dict[int, dict[str, float | str]],
    btc_exposure: float,
    eth_exposure: float,
    hedge_delay_bars: int,
) -> ReplayResult:
    timestamps = sorted(set(btc) & set(eth))
    samples: list[tuple[str, float, float, float]] = []
    delayed: list[float] = []
    for index in range(1, len(timestamps)):
        previous, current = timestamps[index - 1], timestamps[index]
        btc_return = float(btc[current]["close"]) / float(btc[previous]["close"]) - 1
        eth_return = float(eth[current]["close"]) / float(eth[previous]["close"]) - 1
        # Customer exposure is maker's opposite exposure. Positive means customer long.
        maker_loss = max(0.0, btc_exposure * btc_return + eth_exposure * eth_return)
        samples.append((str(btc[current]["iso_time"]), maker_loss, btc_return, eth_return))
        if index >= hedge_delay_bars:
            old = timestamps[index - hedge_delay_bars]
            delayed_return_btc = float(btc[current]["close"]) / float(btc[old]["close"]) - 1
            delayed_return_eth = float(eth[current]["close"]) / float(eth[old]["close"]) - 1
            delayed.append(max(0.0, btc_exposure * delayed_return_btc + eth_exposure * delayed_return_eth))
    if not samples:
        raise ValueError("paired histories contain fewer than two common observations")
    worst = max(samples, key=lambda item: item[1])
    losses = [item[1] for item in samples]
    return ReplayResult(
        observations=len(samples),
        max_portfolio_loss=worst[1],
        max_portfolio_loss_time=worst[0],
        max_btc_abs_return_bps=max(abs(item[2]) for item in samples) * 10_000,
        max_eth_abs_return_bps=max(abs(item[3]) for item in samples) * 10_000,
        p99_portfolio_loss=percentile(losses, 0.99),
        loss_over_150k_count=sum(loss > 150_000 for loss in losses),
        max_hedge_delay_loss=max(delayed, default=0.0),
        hedge_delay_bars=hedge_delay_bars,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--btc", required=True, type=Path)
    parser.add_argument("--eth", required=True, type=Path)
    parser.add_argument("--btc-exposure", type=float, default=250_000)
    parser.add_argument("--eth-exposure", type=float, default=250_000)
    parser.add_argument("--hedge-delay-bars", type=int, default=1)
    args = parser.parse_args()
    result = replay(load(args.btc), load(args.eth), args.btc_exposure, args.eth_exposure, args.hedge_delay_bars)
    print(json.dumps(asdict(result), indent=2))


if __name__ == "__main__":
    main()

