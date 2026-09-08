import unittest

from accounting import (
    absorb_loss,
    account_equity,
    funding_transfers,
    liquidation_chunk,
    margin_requirement,
    oracle_mode,
    post_liquidation_ratio,
    pro_rata_distribution,
)


class AccountingTests(unittest.TestCase):
    def test_margin_is_additive_and_size_sensitive(self):
        self.assertEqual(margin_requirement({"BTC": 20_000, "ETH": -20_000}, True), 8_000)
        self.assertEqual(margin_requirement({"BTC": 60_000}, True), 19_800)

    def test_positive_upnl_does_not_open_new_risk(self):
        self.assertEqual(account_equity(10_000, 5_000, opening_or_withdrawal=True), 10_000)
        self.assertEqual(account_equity(10_000, -5_000, opening_or_withdrawal=True), 5_000)
        self.assertEqual(account_equity(10_000, 5_000), 15_000)

    def test_funding_is_zero_sum_with_maker(self):
        customers, maker = funding_transfers([100_000, -40_000, 10_000], 0.20, 1 / 365)
        self.assertAlmostEqual(sum(customers) + maker, 0.0)
        self.assertGreater(maker, 0.0)

    def test_partial_liquidation_improves_ratio(self):
        before = 10_000 / 100_000
        closed = liquidation_chunk(100_000, 10_000)
        after = post_liquidation_ratio(100_000, 10_000, closed)
        self.assertEqual(closed, 25_000)
        self.assertGreater(after, before)

    def test_small_position_fully_closes(self):
        self.assertEqual(liquidation_chunk(8_000, 500), 8_000)

    def test_loss_waterfall_order(self):
        result = absorb_loss(200_000, 20_000, 50_000, 100_000)
        self.assertEqual(result.account_collateral_used, 20_000)
        self.assertEqual(result.insurance_used, 50_000)
        self.assertEqual(result.maker_used, 100_000)
        self.assertEqual(result.unresolved, 30_000)

    def test_resolution_is_pro_rata_and_order_independent(self):
        first = pro_rata_distribution({"alice": 60, "bob": 40}, 50)
        second = pro_rata_distribution({"bob": 40, "alice": 60}, 50)
        self.assertEqual(first["alice"], 30)
        self.assertEqual(first["bob"], 20)
        self.assertEqual(first, second)

    def test_oracle_modes(self):
        self.assertEqual(oracle_mode(1, 20, 10), "normal")
        self.assertEqual(oracle_mode(3, 20, 10), "guarded")
        self.assertEqual(oracle_mode(1, 120, 10), "paused")
        self.assertEqual(oracle_mode(1, 20, 10, False), "paused")


if __name__ == "__main__":
    unittest.main()

