"""Research-only account, liquidation, oracle, and loss-waterfall model."""

from dataclasses import dataclass
from typing import Iterable, List, Mapping, Sequence, Tuple


@dataclass(frozen=True)
class MarginTier:
    upper_notional: float
    initial_rate: float
    maintenance_rate: float


TIERS: Tuple[MarginTier, ...] = (
    MarginTier(25_000, 0.20, 0.12),
    MarginTier(50_000, 0.25, 0.15),
    MarginTier(100_000, 0.33, 0.20),
)


def tier_for(notional: float, tiers: Sequence[MarginTier] = TIERS) -> MarginTier:
    value = abs(notional)
    for tier in tiers:
        if value <= tier.upper_notional:
            return tier
    raise ValueError("subaccount market notional cap exceeded")


def margin_requirement(positions: Mapping[str, float], initial: bool) -> float:
    total = 0.0
    for position in positions.values():
        tier = tier_for(position)
        rate = tier.initial_rate if initial else tier.maintenance_rate
        total += abs(position) * rate
    return total


def account_equity(
    collateral: float,
    unrealized_pnl: float,
    accrued_funding: float = 0.0,
    fees: float = 0.0,
    opening_or_withdrawal: bool = False,
) -> float:
    pnl_credit = min(unrealized_pnl, 0.0) if opening_or_withdrawal else unrealized_pnl
    return collateral + pnl_credit - accrued_funding - fees


def funding_transfers(customer_positions: Iterable[float], funding_rate: float, year_fraction: float) -> Tuple[List[float], float]:
    """Positive transfer is an account credit; aggregate including maker is zero."""
    customers = [-position * funding_rate * year_fraction for position in customer_positions]
    maker = -sum(customers)
    return customers, maker


def liquidation_chunk(
    absolute_notional: float,
    equity: float,
    target_ratio: float = 0.22,
    penalty_rate: float = 0.005,
    chunk_fraction: float = 0.25,
    full_close_threshold: float = 10_000,
) -> float:
    if absolute_notional <= 0:
        return 0.0
    if absolute_notional <= full_close_threshold or equity <= 0:
        return absolute_notional
    denominator = target_ratio - penalty_rate
    if denominator <= 0:
        raise ValueError("target ratio must exceed liquidation penalty")
    needed = max(0.0, (target_ratio * absolute_notional - equity) / denominator)
    return min(absolute_notional, max(min(needed, absolute_notional * chunk_fraction), 0.0))


def post_liquidation_ratio(absolute_notional: float, equity: float, closed: float, penalty_rate: float = 0.005) -> float:
    remaining = absolute_notional - closed
    if remaining <= 0:
        return float("inf")
    return (equity - closed * penalty_rate) / remaining


@dataclass(frozen=True)
class WaterfallResult:
    account_collateral_used: float
    insurance_used: float
    maker_used: float
    unresolved: float


def absorb_loss(loss: float, account_collateral: float, insurance: float, maker_backing: float) -> WaterfallResult:
    remaining = max(loss, 0.0)
    account_used = min(remaining, max(account_collateral, 0.0))
    remaining -= account_used
    insurance_used = min(remaining, max(insurance, 0.0))
    remaining -= insurance_used
    maker_used = min(remaining, max(maker_backing, 0.0))
    remaining -= maker_used
    return WaterfallResult(account_used, insurance_used, maker_used, remaining)


def pro_rata_distribution(claims: Mapping[str, float], available: float) -> Mapping[str, float]:
    positive = {key: max(value, 0.0) for key, value in claims.items()}
    total = sum(positive.values())
    if total == 0:
        return {key: 0.0 for key in claims}
    ratio = min(1.0, max(available, 0.0) / total)
    return {key: value * ratio for key, value in positive.items()}


def oracle_mode(
    age_seconds: float,
    width_bps: float,
    divergence_bps: float,
    conversion_available: bool = True,
) -> str:
    if not conversion_available or age_seconds > 8 or width_bps > 100 or divergence_bps > 100:
        return "paused"
    if age_seconds > 2 or width_bps > 50 or divergence_bps > 25:
        return "guarded"
    return "normal"

