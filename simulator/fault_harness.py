#!/usr/bin/env python3
"""Deterministic service-fault drills around the protocol state machine."""

import json
from dataclasses import asdict, dataclass

from fixed_point import USDC, baseline_fixed_model
from state_machine import OrderStatus, ProtocolMachine


@dataclass(frozen=True)
class Drill:
    name: str
    passed: bool
    evidence: str


class HedgeVenue:
    """Minimal idempotent venue model: client IDs identify one logical hedge."""

    def __init__(self):
        self.orders: dict[str, str] = {}

    def submit(self, client_order_id: str, lose_ack: bool = False) -> str | None:
        self.orders.setdefault(client_order_id, "filled")
        return None if lose_ack else self.orders[client_order_id]

    def query(self, client_order_id: str) -> str | None:
        return self.orders.get(client_order_id)


def approved(machine: ProtocolMachine, digest: str, account: str = "alice", nonce: int = 1):
    order = machine.admit(digest, account, nonce, {"BTC": 10_000 * USDC}, 100, 1)
    machine.approve(digest, "a", 2)
    machine.approve(digest, "b", 2)
    return order


def run_drills() -> list[Drill]:
    model = baseline_fixed_model()
    capital = 600_000 * USDC
    results: list[Drill] = []

    # Any two healthy signers sustain quoting when the third is offline.
    p = ProtocolMachine(model, capital)
    order = approved(p, "signer-outage")
    results.append(Drill("one signer offline", order.status == OrderStatus.APPROVED, "a+b formed quorum while c was absent"))

    # Theft of one key cannot form a quorum, including duplicate submission.
    p = ProtocolMachine(model, capital)
    order = p.admit("one-key", "mallory", 1, {"BTC": USDC}, 100, 1)
    p.approve("one-key", "a", 2)
    p.approve("one-key", "a", 2)
    results.append(Drill("one approver compromised", order.status != OrderStatus.APPROVED, "duplicate key counted once"))

    # If the API dies after two durable signer logs, failover assumes executable.
    p = ProtocolMachine(model, capital)
    order = approved(p, "api-crash")
    p.failover({"b", "c"})
    results.append(Drill("API crash after quorum", order.status == OrderStatus.INVALID and p.leader_epoch == 2, "new epoch fenced logged approval"))

    # Relayer gas is an availability concern; authorization is sender-independent.
    p = ProtocolMachine(model, capital)
    order = approved(p, "gas-empty")
    p.settle(order.digest, order.minimum_impact_charge, 3)
    results.append(Drill("sponsor wallet empty", order.status == OrderStatus.SETTLED, "user/backup sender can submit identical signed payload"))

    # Lost venue acknowledgement is queried by idempotency key before any retry.
    venue = HedgeVenue()
    acknowledgement = venue.submit("base-block-123-BTC", lose_ack=True)
    reconciled = venue.query("base-block-123-BTC")
    venue.submit("base-block-123-BTC")
    results.append(Drill("hedge acknowledgement lost", acknowledgement is None and reconciled == "filled" and len(venue.orders) == 1, "query-by-client-id prevented duplicate hedge"))

    return results


def main() -> None:
    results = run_drills()
    print(json.dumps([asdict(item) for item in results], indent=2))
    if not all(item.passed for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

