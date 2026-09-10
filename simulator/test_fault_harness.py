import unittest

from fault_harness import run_drills


class FaultHarnessTests(unittest.TestCase):
    def test_all_drills_pass(self):
        results = run_drills()
        self.assertGreaterEqual(len(results), 5)
        self.assertTrue(all(result.passed for result in results), results)


if __name__ == "__main__":
    unittest.main()

