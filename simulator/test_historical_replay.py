import csv
import tempfile
import unittest
from pathlib import Path

from historical_replay import load, replay


class HistoricalReplayTests(unittest.TestCase):
    def write(self, path, closes):
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(("time", "iso_time", "low", "high", "open", "close", "volume"))
            for index, close in enumerate(closes):
                writer.writerow((index * 3600, f"t{index}", close, close, close, close, 1))

    def test_replay_uses_common_timestamps_and_reports_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            btc, eth = Path(directory) / "btc.csv", Path(directory) / "eth.csv"
            self.write(btc, (100, 110, 99))
            self.write(eth, (100, 120, 120))
            result = replay(load(btc), load(eth), 100_000, 100_000, 1)
            self.assertEqual(result.observations, 2)
            self.assertAlmostEqual(result.max_portfolio_loss, 30_000)
            self.assertEqual(result.max_portfolio_loss_time, "t1")


if __name__ == "__main__":
    unittest.main()
