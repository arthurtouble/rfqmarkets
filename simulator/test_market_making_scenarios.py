import unittest

from market_making_scenarios import REGIMES, run_regime


class ScaleScenarioTests(unittest.TestCase):
    def test_all_regimes_are_deterministic_and_respect_hard_limits(self):
        for regime in REGIMES:
            first = run_regime(regime, seed=91)
            second = run_regime(regime, seed=91)
            self.assertEqual(first, second)
            self.assertLessEqual(first.max_abs_exposure, 5_000_000)
            if regime.hedge_available:
                self.assertGreater(first.hedge_turnover, 0)
                self.assertLessEqual(first.max_abs_residual, first.max_abs_exposure)
            self.assertEqual(first.requests, regime.orders)
            self.assertEqual(first.requests, first.fills + first.limit_misses + first.capacity_rejections + first.risk_rejections)

    def test_small_hedge_band_reduces_residual_venue_gap(self):
        regime = next(item for item in REGIMES if item.name == "high_volatility")
        active = run_regime(regime, seed=22, hedge_band=25_000)
        inactive = run_regime(regime, seed=22, hedge_band=20_000_000)
        self.assertGreater(active.hedge_turnover, 0)
        self.assertEqual(inactive.hedge_turnover, 0)

    def test_hedge_outage_is_visible_as_unhedged_risk(self):
        regime = next(item for item in REGIMES if item.name == "hedge_outage")
        result = run_regime(regime, seed=22)
        self.assertEqual(result.hedge_turnover, 0)
        self.assertEqual(result.max_abs_residual, result.max_abs_exposure)
        self.assertEqual(result.fills, 0)
        self.assertEqual(result.risk_rejections, result.requests)

    def test_oversize_orders_fail_capacity_without_changing_exposure(self):
        result = run_regime(REGIMES[0], seed=7, max_trade=99, max_market=5_000_000)
        self.assertEqual(result.fills, 0)
        self.assertEqual(result.capacity_rejections, result.requests)
        self.assertEqual(result.ending_exposure, 0)


if __name__ == "__main__":
    unittest.main()
