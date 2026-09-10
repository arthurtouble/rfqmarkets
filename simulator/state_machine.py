"""Stateful model of quote admission, approval, settlement, and failover."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping

from fixed_point import FixedRiskModel, add, required_impact, required_stress


class OrderStatus(str, Enum):
    RESERVED = "reserved"
    APPROVED = "approved"
    SETTLED = "settled"
    INVALID = "invalid"


@dataclass
class Order:
    digest: str
    account: str
    delta: dict[str, int]
    epoch: int
    expiry: int
    minimum_impact_charge: int
    status: OrderStatus = OrderStatus.RESERVED
    signer_logs: set[str] = field(default_factory=set)


@dataclass
class ProtocolMachine:
    model: FixedRiskModel
    base_risk_capital: int
    signers: set[str] = field(default_factory=lambda: {"a", "b", "c"})
    threshold: int = 2
    leader_epoch: int = 1
    settled: dict[str, int] = field(default_factory=dict)
    orders: dict[str, Order] = field(default_factory=dict)
    used_nonces: set[tuple[str, int]] = field(default_factory=set)
    paused: bool = False

    def live_pending(self) -> list[Mapping[str, int]]:
        return [
            order.delta
            for order in self.orders.values()
            if order.epoch == self.leader_epoch
            and order.status in (OrderStatus.RESERVED, OrderStatus.APPROVED)
        ]

    def admit(self, digest: str, account: str, nonce: int, delta: Mapping[str, int], expiry: int, now: int) -> Order:
        if self.paused or expiry <= now or digest in self.orders:
            raise ValueError("order cannot be admitted")
        if (account, nonce) in self.used_nonces:
            raise ValueError("nonce already used")
        pending = self.live_pending()
        stress = required_stress(self.model, self.settled, pending, delta)
        cap = self.base_risk_capital * self.model.max_stress_fraction // 1_000_000_000_000
        if stress > cap:
            raise ValueError("stress capacity exceeded")
        order = Order(
            digest=digest,
            account=account,
            delta=dict(delta),
            epoch=self.leader_epoch,
            expiry=expiry,
            minimum_impact_charge=required_impact(self.model, self.settled, pending, delta),
        )
        self.orders[digest] = order
        self.used_nonces.add((account, nonce))
        return order

    def approve(self, digest: str, signer: str, now: int) -> None:
        order = self.orders[digest]
        if signer not in self.signers or order.epoch != self.leader_epoch or order.expiry <= now:
            raise ValueError("invalid approval")
        order.signer_logs.add(signer)
        if len(order.signer_logs) >= self.threshold:
            order.status = OrderStatus.APPROVED

    def settle(self, digest: str, charged_impact: int, now: int) -> None:
        order = self.orders[digest]
        if self.paused or order.status != OrderStatus.APPROVED:
            raise ValueError("order is not executable")
        if order.epoch != self.leader_epoch or order.expiry <= now:
            raise ValueError("stale order")
        # On-chain current-state floor catches missing reservations or reordered txs.
        floor = self.model.impact_cost(self.settled, order.delta)
        if charged_impact < floor:
            raise ValueError("impact charge below current-state floor")
        self.settled = add(self.settled, order.delta)
        order.status = OrderStatus.SETTLED

    def failover(self, promotion_signers: set[str]) -> None:
        if len(promotion_signers & self.signers) < self.threshold:
            raise ValueError("promotion certificate lacks quorum")
        self.leader_epoch += 1
        for order in self.orders.values():
            if order.status in (OrderStatus.RESERVED, OrderStatus.APPROVED):
                order.status = OrderStatus.INVALID

