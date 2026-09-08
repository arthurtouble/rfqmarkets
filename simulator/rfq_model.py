"""Executable economic primitives for the RFQ Markets design.

Uses floating-point arithmetic for research simulations only. Production contracts
must use specified fixed-point units and conservative integer rounding.
"""

from dataclasses import dataclass, field
from itertools import combinations
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple


Vector = Dict[str, float]


def add(a: Mapping[str, float], b: Mapping[str, float]) -> Vector:
    keys = set(a) | set(b)
    return {key: a.get(key, 0.0) + b.get(key, 0.0) for key in keys}


@dataclass(frozen=True)
class RiskModel:
    markets: Tuple[str, ...]
    impact_matrix: Mapping[Tuple[str, str], float]
    stress_returns: Tuple[Mapping[str, float], ...]
    max_stress_fraction: float = 0.25

    def potential(self, exposure: Mapping[str, float]) -> float:
        total = 0.0
        for left in self.markets:
            for right in self.markets:
                total += (
                    0.5
                    * exposure.get(left, 0.0)
                    * self.impact_matrix.get((left, right), 0.0)
                    * exposure.get(right, 0.0)
                )
        return total

    def impact_cost(self, exposure: Mapping[str, float], delta: Mapping[str, float]) -> float:
        return self.potential(add(exposure, delta)) - self.potential(exposure)

    def stress_loss(self, exposure: Mapping[str, float]) -> float:
        return max(
            0.0,
            *(sum(exposure.get(m, 0.0) * scenario.get(m, 0.0) for m in self.markets)
              for scenario in self.stress_returns),
        )

    def within_cap(self, exposure: Mapping[str, float], base_risk_capital: float) -> bool:
        return self.stress_loss(exposure) <= base_risk_capital * self.max_stress_fraction


def reachable_exposures(settled: Mapping[str, float], pending: Sequence[Mapping[str, float]]) -> Iterable[Vector]:
    """Enumerate pending execution subsets for small-case testing only."""
    for count in range(len(pending) + 1):
        for subset in combinations(pending, count):
            state = dict(settled)
            for delta in subset:
                state = add(state, delta)
            yield state


def conservative_impact_cost(
    model: RiskModel,
    settled: Mapping[str, float],
    pending: Sequence[Mapping[str, float]],
    new_delta: Mapping[str, float],
) -> float:
    """Choose the greatest user charge required across pending-fill outcomes."""
    return max(model.impact_cost(state, new_delta) for state in reachable_exposures(settled, pending))


def conservative_post_trade_stress(
    model: RiskModel,
    settled: Mapping[str, float],
    pending: Sequence[Mapping[str, float]],
    new_delta: Mapping[str, float],
) -> float:
    return max(model.stress_loss(add(state, new_delta)) for state in reachable_exposures(settled, pending))


@dataclass(frozen=True)
class QuotePolicy:
    base_spread_rate: float = 0.0002
    trading_fee_rate: float = 0.0002
    max_rebate_rate: float = 0.0005
    rebate_spread_fraction: float = 0.50

    def bounded_impact(self, raw_impact: float, notional: float, rebate_budget: float) -> float:
        if raw_impact >= 0:
            return raw_impact
        maximum_credit = min(
            -raw_impact,
            self.rebate_spread_fraction * self.base_spread_rate * abs(notional),
            self.max_rebate_rate * abs(notional),
            max(rebate_budget, 0.0),
        )
        return -maximum_credit

    def total_charge(self, raw_impact: float, notional: float, rebate_budget: float) -> float:
        value = abs(notional)
        return (
            self.base_spread_rate * value
            + self.bounded_impact(raw_impact, value, rebate_budget)
            + self.trading_fee_rate * value
        )


@dataclass
class ReservationBook:
    model: RiskModel
    settled: Vector = field(default_factory=dict)
    pending: List[Vector] = field(default_factory=list)
    quote_policy: QuotePolicy = field(default_factory=QuotePolicy)

    def quote_impact(self, delta: Mapping[str, float]) -> float:
        return conservative_impact_cost(self.model, self.settled, self.pending, delta)

    def quote_total_charge(self, delta: Mapping[str, float], rebate_budget: float = 0.0) -> float:
        raw = self.quote_impact(delta)
        notional = sum(abs(value) for value in delta.values())
        return self.quote_policy.total_charge(raw, notional, rebate_budget)

    def admit(self, delta: Mapping[str, float], base_risk_capital: float) -> float:
        stress = conservative_post_trade_stress(self.model, self.settled, self.pending, delta)
        if stress > base_risk_capital * self.model.max_stress_fraction:
            raise ValueError("portfolio stress capacity exceeded")
        charge = self.quote_impact(delta)
        self.pending.append(dict(delta))
        return charge

    def settle(self, index: int = 0) -> None:
        delta = self.pending.pop(index)
        self.settled = add(self.settled, delta)

    def invalidate(self, index: int = 0) -> None:
        self.pending.pop(index)


def baseline_model() -> RiskModel:
    # At $100k single-market exposure, diagonal derivative is 10 bps for BTC
    # and 12 bps for ETH. Cross terms represent shared directional risk.
    btc_k = 1.0e-8
    eth_k = 1.2e-8
    cross = 0.60 * (btc_k * eth_k) ** 0.5
    return RiskModel(
        markets=("BTC", "ETH"),
        impact_matrix={
            ("BTC", "BTC"): btc_k,
            ("ETH", "ETH"): eth_k,
            ("BTC", "ETH"): cross,
            ("ETH", "BTC"): cross,
        },
        stress_returns=(
            {"BTC": 0.20, "ETH": 0.25},
            {"BTC": -0.20, "ETH": -0.25},
            {"BTC": 0.15, "ETH": -0.20},
            {"BTC": -0.15, "ETH": 0.20},
            {"BTC": 0.40, "ETH": 0.50},
            {"BTC": -0.40, "ETH": -0.50},
        ),
    )
