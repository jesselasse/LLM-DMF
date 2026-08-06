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

from llm_move_agent import generate_payload  # noqa: E402
from move_backend import GenerateDropletArray, Move, RotateMix, Squeeze  # noqa: E402


class FakeChatOpenAI:
    responses = []

    def __init__(self, **_kwargs):
        self._responses = list(self.responses)

    def bind_tools(self, _tools):
        return self

    def invoke(self, _messages):
        if not self._responses:
            raise AssertionError("unexpected LLM invocation")
        return self._responses.pop(0)


class LlmWorkspaceToolTests(unittest.TestCase):
    def test_array_result_can_feed_a_later_operation(self):
        FakeChatOpenAI.responses = [
            AIMessage(
                content="",
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
                            "gap": 2,
                        },
                        "id": "array-call",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(
                content="",
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
            AIMessage(content="已完成阵列移动。"),
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
            (0, 3, 2, 1),
            (4, 3, 2, 1),
        ]
        self.assertEqual(result["workspaceUpdates"]["assayArray"], expected_array)
        self.assertEqual(
            result["sequenceDelta"],
            [(0, [(1, 0, 2, 1), (5, 0, 2, 1), (1, 3, 2, 1), (5, 3, 2, 1)])],
        )
        self.assertEqual(
            [call["tool"] for call in result["moveCalls"]],
            ["generate_array", "move"],
        )

    def test_all_operations_accept_the_same_droplet_list(self):
        droplets = GenerateDropletArray(2, 0, 0, 1, 1, 2)
        self.assertTrue(Move(droplets, "right", 1))
        self.assertTrue(Squeeze(droplets, 1, "right"))
        self.assertTrue(RotateMix(droplets, 1))


if __name__ == "__main__":
    unittest.main()
