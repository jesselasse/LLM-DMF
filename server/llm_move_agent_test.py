import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["OPENAI_BASE_URL"] = "http://example.invalid"
os.environ["OPENAI_API_KEY"] = "test"
os.environ["OPENAI_MODEL"] = "gpt-5.4"
sys.path.insert(0, str(Path(__file__).parent))

from langchain_core.messages import AIMessage  # noqa: E402

from llm_connection_test import tool_binding_options  # noqa: E402
from llm_move_agent import generate_payload  # noqa: E402
from move_backend import Deform, GenerateDropletArray, Merge, Move, RotateMix, Split, SplitToArray, Squeeze  # noqa: E402


class FakeChatOpenAI:
    responses = []
    calls = []
    init_kwargs = []

    def __init__(self, **kwargs):
        self.init_kwargs.append(kwargs)
        self._responses = list(self.responses)

    def bind_tools(self, _tools):
        return self

    def invoke(self, _messages):
        self.calls.append(_messages)
        if not self._responses:
            raise AssertionError("unexpected LLM invocation")
        return self._responses.pop(0)


class LlmWorkspaceToolTests(unittest.TestCase):
    def test_split_to_array_recursively_divides_into_spaced_children(self):
        result = SplitToArray(10, 10, 1, 1, 4, 2, 3, 3)
        self.assertEqual(result[0], (0, [(10, 10, 4, 2)]))
        self.assertEqual(result[-1], (4, [
            (7, 9, 1, 1), (10, 9, 1, 1), (13, 9, 1, 1), (16, 9, 1, 1),
            (7, 12, 1, 1), (10, 12, 1, 1), (13, 12, 1, 1), (16, 12, 1, 1),
        ]))
        with self.assertRaises(ValueError):
            SplitToArray(0, 0, 1, 1, 3, 2, 3, 3)

    def test_split_to_array_tool_derives_its_source_from_the_grid(self):
        FakeChatOpenAI.responses = [
            AIMessage(content="", tool_calls=[{
                "name": "split_to_array",
                "args": {"x": 10, "y": 10, "childW": 1, "childH": 1,
                         "columns": 2, "rows": 2, "gapX": 3, "gapY": 3},
                "id": "split-array", "type": "tool_call",
            }]),
            AIMessage(content="已完成分裂。"),
        ]
        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "将液滴递归分裂为阵列",
                {"sequence": [], "workspaceVariables": {}, "conversation": [], "selectedDroplets": []},
            )
        self.assertEqual(result["moveCalls"][0]["tool"], "split_to_array")
        self.assertEqual(result["workspaceTransitions"][0]["producedDroplets"], [
            (9, 9, 1, 1), (12, 9, 1, 1), (9, 12, 1, 1), (12, 12, 1, 1),
        ])
        self.assertEqual(result["workspaceTransitions"][0]["consumedDroplets"], [(10, 10, 2, 2)])

    def test_initialize_droplets_records_an_initial_frame_before_move(self):
        FakeChatOpenAI.responses = [
            AIMessage(content="", tool_calls=[{
                "name": "initialize_droplets",
                "args": {"x": 1, "y": 2, "w": 1, "h": 1},
                "id": "initialize", "type": "tool_call",
            }]),
            AIMessage(content="", tool_calls=[{
                "name": "move",
                "args": {"direction": "right", "t": 1},
                "id": "move", "type": "tool_call",
            }]),
            AIMessage(content="已完成移动。"),
        ]
        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "将已有液滴向右移动一步",
                {"sequence": [], "workspaceVariables": {}, "conversation": [], "selectedDroplets": []},
            )
        self.assertEqual(result["sequenceDelta"], [
            (0, [(1, 2, 1, 1)]),
            (0, [(2, 2, 1, 1)]),
        ])
        self.assertEqual(result["workspaceTransitions"], [
            {"tool": "initialize_droplets", "consumedDroplets": [], "producedDroplets": [(1, 2, 1, 1)]},
            {"tool": "move", "consumedDroplets": [(1, 2, 1, 1)], "producedDroplets": [(2, 2, 1, 1)]},
        ])

    def test_split_moves_equal_halves_apart_and_supports_long_axis(self):
        self.assertEqual(
            Split([(1, 0, 2, 1)]),
            [(0, [(1, 0, 2, 1)]), (1, [(0, 0, 1, 1), (3, 0, 1, 1)])],
        )
        self.assertEqual(
            Split([(4, 5, 2, 4)]),
            [(0, [(4, 5, 2, 4)]), (1, [(4, 3, 2, 2), (4, 9, 2, 2)])],
        )
        with self.assertRaises(ValueError):
            Split([(0, 0, 3, 2)])

    def test_thinking_mode_does_not_force_an_unsupported_tool_choice(self):
        with patch.dict(os.environ, {"OPENAI_THINKING_MODE": "enabled"}):
            self.assertEqual(tool_binding_options(), {})
        with patch.dict(os.environ, {"OPENAI_THINKING_MODE": "disabled"}):
            self.assertEqual(tool_binding_options(), {"tool_choice": "required"})

    def test_array_result_can_feed_a_later_operation(self):
        FakeChatOpenAI.responses = [
            AIMessage(
                content="",
                usage_metadata={"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
                tool_calls=[
                    {
                        "name": "generate_array",
                        "args": {
                            "outputName": "assayArray",
                            "count": 4,
                            "x": 0,
                            "y": 0,
                            "w": 2,
                            "h": 1,
                            "gap": 4,
                        },
                        "id": "array-call",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="",
                usage_metadata={"input_tokens": 80, "output_tokens": 8, "total_tokens": 88},
                tool_calls=[
                    {
                        "name": "move",
                        "args": {
                            "direction": "right",
                            "t": 1,
                            "droplets": {"workspaceVariable": "assayArray"},
                        },
                        "id": "move-call",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="已完成阵列移动。",
                usage_metadata={"input_tokens": 60, "output_tokens": 6, "total_tokens": 66},
            ),
        ]

        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "生成阵列并向右移动一步",
                {
                    "sequence": [],
                    "workspaceVariables": {},
                    "conversation": [],
                    "selectedDroplets": [],
                },
            )

        expected_array = [
            (0, 0, 2, 1),
            (4, 0, 2, 1),
            (0, 4, 2, 1),
            (4, 4, 2, 1),
        ]
        self.assertEqual(result["workspaceUpdates"]["assayArray"], expected_array)
        self.assertEqual(
            result["sequenceDelta"],
            [(0, [(1, 0, 2, 1), (5, 0, 2, 1), (1, 4, 2, 1), (5, 4, 2, 1)])],
        )
        self.assertEqual(
            [call["tool"] for call in result["moveCalls"]],
            ["generate_array", "move"],
        )
        self.assertEqual(
            result["tokenUsage"],
            {
                "available": True,
                "inputTokens": 240,
                "outputTokens": 24,
                "totalTokens": 264,
            },
        )
        self.assertNotIn("temperature", FakeChatOpenAI.init_kwargs[-1])

    def test_workspace_current_droplets_chain_merge_then_mix(self):
        FakeChatOpenAI.responses = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "generate_array",
                        "args": {"outputName": "left", "count": 2, "x": 0, "y": 0, "w": 2, "h": 2, "gap": 4},
                        "id": "left-array", "type": "tool_call",
                    },
                    {
                        "name": "generate_array",
                        "args": {"outputName": "top", "count": 2, "x": 0, "y": 4, "w": 2, "h": 2, "gap": 4},
                        "id": "top-array", "type": "tool_call",
                    },
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "merge",
                        "args": {
                            "droplets1": {"workspaceVariable": "left"},
                            "droplets2": {"workspaceVariable": "top"},
                        },
                        "id": "merge-call", "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "rotate_mix",
                        "args": {"cycles": 1},
                        "id": "mix-call", "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="已完成合并和混匀。"),
        ]
        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "生成两组阵列，合并后混匀",
                {"sequence": [], "workspaceVariables": {}, "conversation": [], "selectedDroplets": []},
            )
        self.assertEqual([call["tool"] for call in result["moveCalls"]], [
            "generate_array", "generate_array", "merge", "rotate_mix"
        ])
        self.assertEqual(len(result["workspaceTransitions"]), 2)
        self.assertTrue(result["currentDroplets"])

    def test_squeeze_can_generate_multiple_without_array_tool(self):
        FakeChatOpenAI.responses = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "squeeze",
                        "args": {
                            "count": 2,
                            "direction": "right",
                            "x": 10,
                            "y": 10,
                            "w": 5,
                            "h": 5,
                        },
                        "id": "squeeze-call",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="已完成挤出生成。"),
        ]
        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "从一个液滴挤出生成两个液滴",
                {"sequence": [], "workspaceVariables": {}, "conversation": [], "selectedDroplets": []},
            )
        self.assertEqual([call["tool"] for call in result["moveCalls"]], ["squeeze"])
        self.assertNotIn("generate_array", [call["tool"] for call in result["moveCalls"]])

    def test_same_squeeze_parameters_use_one_multi_source_call(self):
        FakeChatOpenAI.responses = [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "squeeze",
                        "args": {
                            "count": 3,
                            "direction": "right",
                            "x": 20,
                            "y": 20,
                            "w": 2,
                            "h": 2,
                        },
                        "id": "squeeze-call-1",
                        "type": "tool_call",
                    },
                    {
                        "name": "squeeze",
                        "args": {
                            "count": 3,
                            "direction": "right",
                            "x": 20,
                            "y": 60,
                            "w": 2,
                            "h": 2,
                        },
                        "id": "squeeze-call-2",
                        "type": "tool_call",
                    },
                ],
            ),
            AIMessage(content="已完成并行挤出。"),
        ]
        with patch("langchain_openai.ChatOpenAI", FakeChatOpenAI):
            result = generate_payload(
                "在两个位置向右挤出相同数量的液滴",
                {"sequence": [], "workspaceVariables": {}, "conversation": [], "selectedDroplets": []},
            )
        self.assertEqual([call["tool"] for call in result["moveCalls"]], ["squeeze", "squeeze"])
        self.assertEqual(len(result["sequenceDelta"]), 16)

    def test_all_operations_accept_the_same_droplet_list(self):
        droplets = GenerateDropletArray(2, 0, 0, 1, 1, 2)
        self.assertTrue(Move(droplets, "right", 1))
        self.assertTrue(Squeeze(droplets, 1, "right"))
        self.assertTrue(RotateMix(droplets, 1))

    def test_array_gap_is_origin_spacing_and_exceeds_width(self):
        self.assertEqual(
            GenerateDropletArray(4, 10, 20, 2, 2, 8),
            [(10, 20, 2, 2), (18, 20, 2, 2), (10, 28, 2, 2), (18, 28, 2, 2)],
        )
        with self.assertRaises(ValueError):
            GenerateDropletArray(2, 0, 0, 2, 2, 2)

    def test_array_can_use_explicit_rows_columns_and_axis_gaps(self):
        self.assertEqual(
            GenerateDropletArray(
                None, 10, 20, 2, 1, None,
                rows=2, columns=3, gap_x=5, gap_y=4,
            ),
            [
                (10, 20, 2, 1), (15, 20, 2, 1), (20, 20, 2, 1),
                (10, 24, 2, 1), (15, 24, 2, 1), (20, 24, 2, 1),
            ],
        )

    def test_merge_moves_then_deforms_two_horizontal_droplets(self):
        result = Merge([(0, 0, 2, 2)], [(5, 0, 1, 3)])
        self.assertEqual(result[0], (0, [(1, 0, 2, 2), (4, 0, 1, 3)]))
        self.assertEqual(result[1], (1, [(2, 0, 2, 2), (4, 0, 1, 3)]))
        # Total area is 7, so the compact target is 3x3 rather than a long strip.
        self.assertEqual(result[-1][1][0][2:], (3, 3))
        self.assertEqual(len(result[-1][1]), 1)

    def test_merge_requires_two_aligned_droplets(self):
        with self.assertRaises(ValueError):
            Merge([(0, 0, 1, 1)], [])
        with self.assertRaises(ValueError):
            Merge([(0, 0, 1, 1)], [(4, 4, 1, 1), (8, 8, 1, 1)])
        with self.assertRaises(ValueError):
            Merge([(0, 0, 1, 1)], [(4, 4, 1, 1)])

    def test_merge_pairs_two_arrays_by_index(self):
        result = Merge(
            [(0, 0, 2, 2), (0, 10, 2, 2)],
            [(4, 0, 2, 2), (4, 10, 2, 2)],
        )
        self.assertEqual(result[0][1], [(1, 0, 2, 2), (3, 0, 2, 2), (1, 10, 2, 2), (3, 10, 2, 2)])
        self.assertEqual(result[-1][1], [(1, 0, 4, 2), (1, 10, 4, 2)])

    def test_deform_accepts_adjacent_rectangles(self):
        result = Deform([(0, 0, 2, 2), (2, 0, 1, 3)])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0][1][0][2:], (3, 3))

    def test_deform_preserves_an_already_filled_rectangle(self):
        result = Deform([(23, 20, 2, 2), (25, 20, 1, 2)])
        self.assertEqual(result, [(0, [(23, 20, 3, 2)])])


if __name__ == "__main__":
    unittest.main()
