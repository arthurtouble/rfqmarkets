import unittest
from walk_forward_calibration import Observation, calibrate

class WalkForwardCalibrationTests(unittest.TestCase):
    def test_split_is_chronological_and_holdout_is_reported(self):
        rows=[]
        for index in range(100):
            vol=5+(index%10);tox=(index%7)*2;hedge=index%4;basis=(index%5)-2
            adverse=2+vol*.3+tox*.5+hedge+abs(basis)*.5
            rows.append(Observation(index,vol,tox,hedge,basis,adverse))
        result=calibrate(rows)
        self.assertEqual(result["train"]["observations"],60)
        self.assertEqual(result["validation"]["observations"],20)
        self.assertEqual(result["holdout"]["observations"],20)
        self.assertLess(result["holdout"]["underquoteRate"],.5)

    def test_future_outlier_cannot_change_training_partition(self):
        base=[Observation(i,10,4,2,1,8) for i in range(100)]
        ordinary=calibrate(base)
        base[-1]=Observation(99,2_000,10_000,100,500,100)
        stressed=calibrate(base)
        self.assertEqual(ordinary["weights"],stressed["weights"])

if __name__=="__main__": unittest.main()
