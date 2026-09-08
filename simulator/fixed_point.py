"""Contract-shaped integer arithmetic for RFQ inventory and stress checks.

All notionals and returned costs are USDC micro-units (1 USDC = 1_000_000).
Rates use 1e12 precision. Division rounds toward negative infinity so a sequence
of potential differences telescopes exactly, independent of wallet splitting.
"""

from dataclasses import dataclass
from itertools import combinations
from typing import Iterable, Mapping, Sequence


USDC = 1_000_000
RATE = 1_000_000_000_000


def mul_div_floor(a: int, b: int, denominator: int) -> int:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    return (a * b) // denominator


def add(a: Mapping[str, int], b: Mapping[str, int]) -> dict[str, int]:
    return {key: a.get(key, 0) + b.get(key, 0) for key in set(a) | set(b)}


@dataclass(frozen=True)
class FixedRiskModel:
    markets: tuple[str, ...]
    # Dimensionless quadratic coefficient scaled by RATE.
    impact: Mapping[tuple[str, str], int]
    # Signed scenario returns scaled by RATE.
    stress_returns: tuple[Mapping[str, int], ...]
    max_stress_fraction: int = RATE // 4

    def potential(self, exposure: Mapping[str, int]) -> int:
        numerator = 0
        for left in self.markets:
            for right in self.markets:
                numerator += (
                    exposure.get(left, 0)
                    * self.impact.get((left, right), 0)
                    * exposure.get(right, 0)
                )
        return numerator // (2 * RATE * USDC)

    def impact_cost(self, exposure: Mapping[str, int], delta: Mapping[str, int]) -> int:
        return self.potential(add(exposure, delta)) - self.potential(exposure)

    def stress_loss(self, exposure: Mapping[str, int]) -> int:
        losses = [0]
        for scenario in self.stress_returns:
            pnl = sum(
                mul_div_floor(exposure.get(market, 0), scenario.get(market, 0), RATE)
                for market in self.markets
            )
            losses.append(pnl)
        return max(losses)

    def within_cap(self, exposure: Mapping[str, int], base_risk_capital: int) -> bool:
        cap = mul_div_floor(base_risk_capital, self.max_stress_fraction, RATE)
        return self.stress_loss(exposure) <= cap


def reachable_exposures(
    settled: Mapping[str, int], pending: Sequence[Mapping[str, int]]
) -> Iterable[dict[str, int]]:
    for count in range(len(pending) + 1):
        for subset in combinations(pending, count):
            state = dict(settled)
            for delta in subset:
                state = add(state, delta)
            yield state


def required_impact(
    model: FixedRiskModel,
    settled: Mapping[str, int],
    pending: Sequence[Mapping[str, int]],
    delta: Mapping[str, int],
) -> int:
    return max(model.impact_cost(state, delta) for state in reachable_exposures(settled, pending))


def required_stress(
    model: FixedRiskModel,
    settled: Mapping[str, int],
    pending: Sequence[Mapping[str, int]],
    delta: Mapping[str, int],
) -> int:
    return max(model.stress_loss(add(state, delta)) for state in reachable_exposures(settled, pending))


def baseline_fixed_model() -> FixedRiskModel:
    # k_BTC=1e-8, k_ETH=1.2e-8; cross approximates 0.60*sqrt(k1*k2).
    return FixedRiskModel(
        markets=("BTC", "ETH"),
        impact={
            ("BTC", "BTC"): 10_000,
            ("ETH", "ETH"): 12_000,
            ("BTC", "ETH"): 6_573,
            ("ETH", "BTC"): 6_573,
        },
        stress_returns=(
            {"BTC": 200_000_000_000, "ETH": 250_000_000_000},
            {"BTC": -200_000_000_000, "ETH": -250_000_000_000},
            {"BTC": 150_000_000_000, "ETH": -200_000_000_000},
            {"BTC": -150_000_000_000, "ETH": 200_000_000_000},
            {"BTC": 400_000_000_000, "ETH": 500_000_000_000},
            {"BTC": -400_000_000_000, "ETH": -500_000_000_000},
        ),
    )

