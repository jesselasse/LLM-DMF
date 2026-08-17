import unittest

from audit_tool_calls import replay_with_outputs


class AuditToolCallOutputsTest(unittest.TestCase):
    def test_split_to_array_replay_returns_all_final_children(self):
        _sequence, outputs = replay_with_outputs([{
            "tool": "split_to_array",
            "args": {
                "x": 10, "y": 10, "childW": 1, "childH": 1,
                "columns": 2, "rows": 2, "gapX": 3, "gapY": 3,
            },
        }])
        self.assertEqual(outputs, [
            (10, 10, 1, 1), (13, 10, 1, 1), (10, 13, 1, 1), (13, 13, 1, 1),
        ])

    def test_initialize_droplets_replays_as_the_initial_frame(self):
        sequence, outputs = replay_with_outputs([{
            "tool": "initialize_droplets",
            "args": {"x": 1, "y": 2, "w": 1, "h": 1},
            "resolvedDroplets": [{"x": 1, "y": 2, "w": 1, "h": 1}],
        }])
        self.assertEqual(sequence, [(0, [(1, 2, 1, 1)])])
        self.assertEqual(outputs, [(1, 2, 1, 1)])

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
