import csv,tempfile,unittest
from pathlib import Path
from flow_calibration_lab import Trade,bucket_tape,build_observations,capture_integrity,load_tape

class FlowCalibrationLabTests(unittest.TestCase):
    def tape(self):
        rows=[]
        for index in range(600):
            market="BTC" if index%2==0 else "ETH";base=100_000 if market=="BTC" else 4_000;price=base*(1+index*.000001)
            rows.append(Trade(index*500,"coinbase",market,str(index),price,.01,"buy" if index%3 else "sell",price-.5,price+.5))
        return rows

    def test_builds_deterministic_multi_regime_causal_observations(self):
        first=build_observations(self.tape(),(1000,5000),(.05,.9),11);second=build_observations(self.tape(),(1000,5000),(.05,.9),11)
        self.assertEqual(first,second);self.assertGreater(len(first),100)
        self.assertEqual({row.regime for row in first},{"toxic-05","toxic-90"})
        self.assertTrue(all(row.label_end_timestamp>row.timestamp for row in first))

    def test_bucketing_aggregates_volume_without_duplicate_flow_weight(self):
        rows=[Trade(10,"coinbase","BTC","1",100.,1.,"buy",99.,101.),Trade(20,"coinbase","BTC","2",102.,3.,"buy",100.,103.)]
        result=bucket_tape(rows);self.assertEqual(len(result),1);self.assertEqual(result[0].size_base,4.);self.assertEqual(result[0].price,101.5)

    def test_loader_deduplicates_venue_trade_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"tape.csv"
            with path.open("w",newline="") as handle:
                writer=csv.writer(handle);writer.writerow(("timestamp_ms","venue","market","trade_id","price","size_base","taker_side","bid","ask"))
                for index,row in enumerate(self.tape()[:60]):
                    values=(row.timestamp_ms,row.venue,row.market,str(index),row.price,row.size_base,row.taker_side,row.bid,row.ask);writer.writerow(values);writer.writerow(values)
            self.assertEqual(len(load_tape(str(path))),60)

    def test_capture_integrity_fails_closed_and_accepts_clean_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"tape.csv"
            self.assertFalse(capture_integrity(str(path))["summaryPresent"])
            Path(f"{path}.summary.json").write_text('{"errors":[],"sequenceGaps":{"coinbase":"0","binance":"0"}}')
            self.assertTrue(all(capture_integrity(str(path)).values()))
            Path(f"{path}.summary.json").write_text('{"errors":["coinbase:transport"],"sequenceGaps":{"coinbase":"2","binance":"0"}}')
            self.assertFalse(capture_integrity(str(path))["noReportedTransportErrors"])
            self.assertFalse(capture_integrity(str(path))["noReportedSequenceGaps"])

if __name__=="__main__":unittest.main()
