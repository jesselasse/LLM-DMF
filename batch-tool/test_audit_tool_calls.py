import unittest

from audit_tool_calls import replay_with_outputs


class AuditToolCallOutputsTest(unittest.TestCase):
    def test_squeeze_outputs_exclude_the_source_in_every_direction(self):
        source = {"x": 60, "y": 60, "w": 2, "h": 3}
        for direction in ("right", "left", "up", "down"):
            for count in (1, 2, 3, 10):
                with self.subTest(direction=direction, count=count):
                    _sequence, outputs = replay_with_outputs([
                        {
                            "tool": "squeeze",
                            "args": {"count": count, "direction": direction, **source},
                            "resolvedDroplets": [source],
                        }
                    ])
                    self.assertEqual(len(outputs), count)
                    self.assertNotIn((60, 60, 2, 3), outputs)


if __name__ == "__main__":
    unittest.main()
