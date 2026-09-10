import unittest

from adversarial_scenarios import admission_mode, admits, latency_move_bps, oracle_decision, quadratic_inventory_charge


class AdversarialScenarioTests(unittest.TestCase):
    def test_sybil_splitting_cannot_reset_inventory_charge(self):
        one_wallet = quadratic_inventory_charge(250_000, [400_000])
        many_wallets = quadratic_inventory_charge(250_000, [4_000] * 100)
        self.assertAlmostEqual(one_wallet, many_wallets, places=8)

    def test_parallel_pending_burst_is_charged_as_portfolio_exposure(self):
        sequential = quadratic_inventory_charge(0, [50_000] * 20)
        self.assertAlmostEqual(sequential, quadratic_inventory_charge(0, [1_000_000]), places=8)
        self.assertGreater(sequential, 0)

    def test_oracle_disagreement_degrades_before_failing_closed(self):
        self.assertEqual(oracle_decision(100, [99.9, 100, 100.1], 200).mode, "normal")
        self.assertEqual(oracle_decision(100.4, [99.9, 100, 100.1], 200).mode, "guarded")
        self.assertEqual(oracle_decision(102, [99.9, 100, 100.1], 200).mode, "reduce_only")

    def test_stale_oracle_fails_closed_even_when_prices_agree(self):
        self.assertEqual(oracle_decision(100, [100, 100], 3_001).mode, "reduce_only")

    def test_high_volatility_latency_budget_scales_with_square_root_time(self):
        fast = latency_move_bps(30, 200)
        slow = latency_move_bps(30, 800)
        self.assertAlmostEqual(slow, fast * 2, places=8)

    def test_hedge_outage_allows_only_strict_deleveraging(self):
        mode = admission_mode(10_000, 25_000, False)
        self.assertEqual(mode, "reduce_only")
        self.assertTrue(admits(mode, 100_000, -25_000, 1_000_000))
        self.assertFalse(admits(mode, 100_000, 25_000, 1_000_000))
        self.assertFalse(admits(mode, 100_000, -200_000, 1_000_000))

    def test_guarded_mode_halves_order_capacity(self):
        mode = admission_mode(30_000, 25_000, True)
        self.assertEqual(mode, "guarded")
        self.assertTrue(admits(mode, 0, 500_000, 1_000_000))
        self.assertFalse(admits(mode, 0, 500_001, 1_000_000))


if __name__ == "__main__":
    unittest.main()
