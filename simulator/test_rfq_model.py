import random
import unittest

from rfq_model import ReservationBook, baseline_model


class EconomicInvariantTests(unittest.TestCase):
    def setUp(self):
        self.model = baseline_model()

    def test_splitting_does_not_reset_impact(self):
        whole = self.model.impact_cost({}, {"BTC": 100_000})
        state = {}
        split = 0.0
        for _ in range(10):
            delta = {"BTC": 10_000}
            split += self.model.impact_cost(state, delta)
            state["BTC"] = state.get("BTC", 0) + 10_000
        self.assertAlmostEqual(whole, split)

    def test_impact_matrix_is_positive_semidefinite(self):
        btc = self.model.impact_matrix[("BTC", "BTC")]
        eth = self.model.impact_matrix[("ETH", "ETH")]
        cross = self.model.impact_matrix[("BTC", "ETH")]
        self.assertGreaterEqual(btc, 0)
        self.assertGreaterEqual(eth, 0)
        self.assertGreaterEqual(btc * eth - cross * cross, 0)

    def test_random_partitions_do_not_reset_impact(self):
        rng = random.Random(7)
        for _ in range(250):
            pieces = [rng.uniform(1, 10_000) for _ in range(rng.randint(1, 30))]
            whole = self.model.impact_cost({}, {"BTC": sum(pieces)})
            state = {}
            split = 0.0
            for piece in pieces:
                split += self.model.impact_cost(state, {"BTC": piece})
                state["BTC"] = state.get("BTC", 0) + piece
            self.assertAlmostEqual(whole, split, places=8)

    def test_different_wallets_share_reservations(self):
        book = ReservationBook(self.model)
        first = book.admit({"BTC": 10_000}, 1_000_000)
        second = book.admit({"BTC": 10_000}, 1_000_000)
        self.assertGreater(second, first)

    def test_pending_offset_gets_no_unearned_discount(self):
        book = ReservationBook(self.model)
        book.admit({"BTC": 100_000}, 1_000_000)
        sell_charge = book.quote_impact({"BTC": -10_000})
        self.assertGreaterEqual(sell_charge, 0.0)

    def test_real_offset_can_receive_discount(self):
        book = ReservationBook(self.model)
        book.admit({"BTC": 100_000}, 1_000_000)
        book.settle()
        sell_charge = book.quote_impact({"BTC": -10_000})
        self.assertLess(sell_charge, 0.0)

    def test_inventory_credit_is_bounded_and_total_charge_positive(self):
        book = ReservationBook(self.model, settled={"BTC": 100_000})
        raw = book.quote_impact({"BTC": -10_000})
        bounded = book.quote_policy.bounded_impact(raw, 10_000, rebate_budget=1_000)
        self.assertLess(bounded, 0)
        self.assertGreaterEqual(bounded, -1.0)  # half of the 2 bps spread charge
        self.assertGreater(book.quote_total_charge({"BTC": -10_000}, rebate_budget=1_000), 0)

    def test_no_rebate_without_funded_budget(self):
        book = ReservationBook(self.model, settled={"BTC": 100_000})
        raw = book.quote_impact({"BTC": -10_000})
        self.assertEqual(book.quote_policy.bounded_impact(raw, 10_000, rebate_budget=0), 0)

    def test_stale_cheap_quote_fails_current_state_bound(self):
        cheap_charge = self.model.impact_cost({}, {"BTC": 10_000})
        required_after_prior_fill = self.model.impact_cost({"BTC": 100_000}, {"BTC": 10_000})
        self.assertLess(cheap_charge, required_after_prior_fill)

    def test_correlated_market_exposure_increases_impact(self):
        eth_alone = self.model.impact_cost({}, {"ETH": 10_000})
        eth_with_btc = self.model.impact_cost({"BTC": 100_000}, {"ETH": 10_000})
        self.assertGreater(eth_with_btc, eth_alone)

    def test_stress_cap_applies_across_pending_wallets(self):
        book = ReservationBook(self.model)
        book.admit({"BTC": 300_000}, 1_000_000)
        with self.assertRaises(ValueError):
            book.admit({"ETH": 500_000}, 1_000_000)


if __name__ == "__main__":
    unittest.main()
