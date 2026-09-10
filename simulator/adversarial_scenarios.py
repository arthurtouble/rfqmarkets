"""Deterministic adversarial checks for RFQ admission and quote protection."""
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class OracleDecision:
    mode: str
    divergence_bps: float
    age_ms: int


def oracle_decision(primary: float, references: Iterable[float], age_ms: int) -> OracleDecision:
    refs = sorted(references)
    if primary <= 0 or not refs:
        return OracleDecision("reduce_only", float("inf"), age_ms)
    median = refs[len(refs) // 2]
    divergence = abs(primary / median - 1) * 10_000
    if age_ms > 3_000 or divergence > 100:
        mode = "reduce_only"
    elif age_ms > 1_500 or divergence > 25:
        mode = "guarded"
    else:
        mode = "normal"
    return OracleDecision(mode, divergence, age_ms)


def quadratic_inventory_charge(start: float, trades: Iterable[float], coefficient: float = 1e-8) -> float:
    exposure, total = start, 0.0
    for trade in trades:
        before = 0.5 * coefficient * exposure * exposure
        exposure += trade
        total += 0.5 * coefficient * exposure * exposure - before
    return total


def latency_move_bps(volatility_bps_per_second: float, latency_ms: int, shock_sigma: float = 3.0) -> float:
    return shock_sigma * volatility_bps_per_second * (max(latency_ms, 0) / 1_000) ** 0.5


def admission_mode(hedge_gap: float, band: float, hedge_healthy: bool) -> str:
    if not hedge_healthy or abs(hedge_gap) > 2 * band:
        return "reduce_only"
    if abs(hedge_gap) > band:
        return "guarded"
    return "normal"


def admits(mode: str, exposure: float, delta: float, normal_limit: float) -> bool:
    if abs(delta) > (normal_limit / 2 if mode == "guarded" else normal_limit):
        return False
    if mode == "reduce_only":
        return abs(exposure + delta) < abs(exposure)
    return True
