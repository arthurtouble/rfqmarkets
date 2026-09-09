"""Deterministic scale laboratory for quote, inventory, toxicity, and hedge policy.

This is an economic/adversarial harness, not a forecast. Dollar values are floats so
large sweeps remain fast; contract equivalence belongs in fixed_point.py.
"""
from dataclasses import asdict, dataclass
import argparse
import json
import math
import random


@dataclass(frozen=True)
class Regime:
    name: str
    volatility_bps: float
    drift_bps: float
    toxic_fraction: float
    orders: int
    hedge_available: bool = True


REGIMES = (
    Regime("calm", 3, 0, 0.05, 2_000),
    Regime("trend", 18, 1.5, 0.25, 2_000),
    Regime("high_volatility", 75, 0, 0.40, 2_000),
    Regime("crash", 140, -18, 0.65, 1_000),
    Regime("hedge_outage", 35, 0, 0.30, 1_000, False),
)


@dataclass
class Metrics:
    regime: str
    requests: int = 0
    fills: int = 0
    limit_misses: int = 0
    capacity_rejections: int = 0
    quote_revenue: float = 0
    mark_to_market: float = 0
    hedge_cost: float = 0
    hedge_turnover: float = 0
    max_abs_exposure: float = 0
    max_abs_residual: float = 0
    ending_exposure: float = 0
    ending_residual: float = 0
    pnl: float = 0


def run_regime(regime: Regime, seed: int = 1, max_trade: float = 1_000_000,
               max_market: float = 5_000_000, hedge_band: float = 100_000,
               hedge_slice: float = 500_000) -> Metrics:
    rng = random.Random(seed)
    price, exposure, hedge_position = 100_000.0, 0.0, 0.0
    metrics = Metrics(regime=regime.name)
    sizes = (100, 1_000, 10_000, 50_000, 250_000, 1_000_000)
    for _ in range(regime.orders):
        shock_bps = regime.drift_bps + rng.gauss(0, regime.volatility_bps)
        old_price = price
        price *= math.exp(shock_bps / 10_000)
        metrics.mark_to_market -= (exposure - hedge_position) * (price / old_price - 1)
        toxic = rng.random() < regime.toxic_fraction
        side = 1 if (toxic and shock_bps > 0) or (not toxic and rng.random() < .5) else -1
        amount = float(rng.choice(sizes))
        metrics.requests += 1
        if amount > max_trade or abs(exposure + side * amount) > max_market:
            metrics.capacity_rejections += 1
            continue
        inventory_bps = max(0.0, side * exposure / 1_000_000 * 10)
        spread_bps = 2 + min(50, regime.volatility_bps * .15) + inventory_bps
        is_limit = rng.random() < .35
        limit_offset_bps = rng.choice((-20, -5, 0, 5, 20))
        marketable = not is_limit or (side > 0 and limit_offset_bps >= spread_bps) or (side < 0 and -limit_offset_bps >= spread_bps)
        if not marketable:
            metrics.limit_misses += 1
            continue
        exposure += side * amount
        metrics.fills += 1
        metrics.quote_revenue += amount * (spread_bps + 2) / 10_000
        metrics.max_abs_exposure = max(metrics.max_abs_exposure, abs(exposure))
        gap = exposure - hedge_position
        if regime.hedge_available and abs(gap) > hedge_band:
            hedge = math.copysign(min(abs(gap) - hedge_band / 2, hedge_slice), gap)
            hedge_position += hedge
            metrics.hedge_turnover += abs(hedge)
            metrics.hedge_cost += abs(hedge) * (1.5 + regime.volatility_bps * .05) / 10_000
        metrics.max_abs_residual = max(metrics.max_abs_residual, abs(exposure - hedge_position))
    metrics.ending_exposure = exposure
    metrics.ending_residual = exposure - hedge_position
    metrics.pnl = metrics.quote_revenue + metrics.mark_to_market - metrics.hedge_cost
    return metrics


def run_suite(seed: int = 1):
    return [asdict(run_regime(regime, seed + index)) for index, regime in enumerate(REGIMES)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    print(json.dumps(run_suite(args.seed), indent=2))
