import random
import unittest

from fixed_point import USDC, baseline_fixed_model
from state_machine import OrderStatus, ProtocolMachine


class FixedPointTests(unittest.TestCase):
    def setUp(self):
        self.model = baseline_fixed_model()

    def test_partition_telescopes_exactly_at_micro_unit_precision(self):
        rng = random.Random(17)
        for _ in range(500):
            pieces = [rng.randint(1, 10_000) * USDC for _ in range(rng.randint(1, 30))]
            whole = self.model.impact_cost({}, {"BTC": sum(pieces)})
            state = {}
            split = 0
            for piece in pieces:
                split += self.model.impact_cost(state, {"BTC": piece})
                state["BTC"] = state.get("BTC", 0) + piece
            self.assertEqual(whole, split)

    def test_fixed_matrix_is_psd(self):
        a = self.model.impact[("BTC", "BTC")]
        b = self.model.impact[("ETH", "ETH")]
        c = self.model.impact[("BTC", "ETH")]
        self.assertGreaterEqual(a * b - c * c, 0)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.model = baseline_fixed_model()

    def machine(self):
        return ProtocolMachine(self.model, 600_000 * USDC)

    def test_two_distinct_signers_required(self):
        p = self.machine()
        order = p.admit("one", "alice", 1, {"BTC": 10_000 * USDC}, 20, 1)
        p.approve("one", "a", 2)
        p.approve("one", "a", 2)
        self.assertEqual(order.status, OrderStatus.RESERVED)
        p.approve("one", "b", 2)
        self.assertEqual(order.status, OrderStatus.APPROVED)

    def test_wallet_split_is_reserved_globally(self):
        p = self.machine()
        first = p.admit("one", "alice", 1, {"BTC": 10_000 * USDC}, 20, 1)
        second = p.admit("two", "bob", 1, {"BTC": 10_000 * USDC}, 20, 1)
        self.assertGreater(second.minimum_impact_charge, first.minimum_impact_charge)

    def test_failover_invalidates_old_epoch_approvals(self):
        p = self.machine()
        order = p.admit("one", "alice", 1, {"BTC": 10_000 * USDC}, 20, 1)
        p.approve("one", "a", 2)
        p.approve("one", "b", 2)
        p.failover({"b", "c"})
        self.assertEqual(order.status, OrderStatus.INVALID)
        with self.assertRaises(ValueError):
            p.settle("one", order.minimum_impact_charge, 3)

    def test_reordered_stale_cheap_quote_fails_contract_floor(self):
        p = self.machine()
        first = p.admit("one", "alice", 1, {"BTC": 100_000 * USDC}, 20, 1)
        # Simulate faulty API omitting the pending first order.
        saved = p.orders.pop("one")
        second = p.admit("two", "bob", 1, {"BTC": 10_000 * USDC}, 20, 1)
        p.orders["one"] = saved
        for digest in ("one", "two"):
            p.approve(digest, "a", 2)
            p.approve(digest, "b", 2)
        p.settle("one", first.minimum_impact_charge, 3)
        with self.assertRaises(ValueError):
            p.settle("two", second.minimum_impact_charge, 3)

    def test_expiry_and_nonce_replay_fail(self):
        p = self.machine()
        p.admit("one", "alice", 7, {"ETH": USDC}, 3, 1)
        with self.assertRaises(ValueError):
            p.admit("two", "alice", 7, {"ETH": USDC}, 3, 1)
        with self.assertRaises(ValueError):
            p.approve("one", "a", 3)


if __name__ == "__main__":
    unittest.main()
