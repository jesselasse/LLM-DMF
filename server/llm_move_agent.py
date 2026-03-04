"""
LLM router:
Natural-language message + full context -> LLM tool call Move() -> incremental steps.

Input (stdin JSON):
  {
    "message": "...",
    "context": {
      "sequenceText": "...",
      "conversation": [{"role":"user|assistant","content":"..."}]
    }
  }

Output (stdout JSON):
  {
    "assistantReply": "...",
    "stepsTextDelta": "(x,y)(w,h)-1000\\n...",
    "moveCalls": [...]
  }
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
from move_backend import Move_as_txt, Squeeze_as_txt


def _normalize_message_to_text(message: Any) -> str:
    text = "" if message is None else str(message)
    return text.strip()


def _normalize_context(raw_context: Any) -> Dict[str, Any]:
    if not isinstance(raw_context, dict):
        return {"sequenceText": "", "conversation": []}

    sequence_text = raw_context.get("sequenceText", "")
    if not isinstance(sequence_text, str):
        sequence_text = str(sequence_text or "")

    conversation = raw_context.get("conversation", [])
    if not isinstance(conversation, list):
        conversation = []

    normalized_conversation = []
    for item in conversation:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            normalized_conversation.append({"role": role, "content": content})

    return {
        "sequenceText": sequence_text,
        "conversation": normalized_conversation,
    }


def _run_with_langchain(message: str, context: Dict[str, Any]) -> Dict[str, Any]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI

    @tool("move")
    def move(x: int, y: int, w: int, h: int, direction: str, t: int) -> str:
        """
        Move one droplet (x, y, w, h) along direction by t grid steps.
        direction in [up, down, left, right] (Chinese directions are also supported).
        Returns txt activation sequence where each line is one moved step.
        """
        return Move_as_txt((x, y, w, h), direction, t)

    @tool("squeeze")
    def squeeze(count: int, x: int, y: int, direction: str) -> str:
        """
        Generate squeezing sequence from template.
        count controls truncation (1->6, 2->11, each extra +5).
        x,y are translation offsets; direction controls rotation.
        """
        return Squeeze_as_txt(count, x, y, direction)

    model_name = os.getenv("OPENAI_MODEL", LLM_MODEL)
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
    )
    llm_with_tools = llm.bind_tools([move, squeeze])

    system_prompt = (
        "You are a DMF workflow planner.\n"
        "You have FULL context of prior conversation and the FULL stored sequence text.\n"
        "For movement, call tool 'move'. For generation requests, call tool 'squeeze'.\n"
        "If user says '再/继续/then/again' and omits coordinates, infer target droplet from existing sequence/context.\n"
        "If there are multiple droplets and request is ambiguous, ask clarification and do not call tools.\n"
        "Return concise Chinese assistant reply."
    )

    messages: List[Any] = [SystemMessage(content=system_prompt)]

    for item in context.get("conversation", []):
        if item["role"] == "user":
            messages.append(HumanMessage(content=item["content"]))
        elif item["role"] == "assistant":
            messages.append(AIMessage(content=item["content"]))

    sequence_text = context.get("sequenceText", "")
    messages.append(
        HumanMessage(
            content=(
                "以下是当前已经存储的完整激活序列（可能为空）：\n"
                f"{sequence_text if sequence_text.strip() else '[EMPTY]'}\n\n"
                "你现在只需要在这个基础上处理新请求，并生成新增步骤（delta）。\n"
                f"新请求：{message}"
            )
        )
    )

    ai_msg = llm_with_tools.invoke(messages)
    tool_calls = getattr(ai_msg, "tool_calls", None) or []


    tool_messages: List[ToolMessage] = []
    steps_outputs: List[str] = []
    move_calls: List[Dict[str, Any]] = []

    for call in tool_calls:
        name = call.get("name")
        if name not in ("move", "squeeze"):
            continue
        args = call.get("args", {})
        if name == "move":
            tool_result = move.invoke(args)
        else:
            tool_result = squeeze.invoke(args)
        steps_outputs.append(tool_result)
        move_calls.append({"tool": name, "args": args})
        tool_messages.append(
            ToolMessage(
                content=tool_result,
                tool_call_id=call["id"],
                name=name,
            )
        )

    if not steps_outputs:
        raise RuntimeError("No Move output generated from tool calls.")

    followup_messages: List[Any] = [
        *messages,
        ai_msg,
        *tool_messages,
        HumanMessage(
            content=(
                "请用一句中文回复用户你理解到的动作和结果，不要输出代码块。"
            )
        ),
    ]
    final_msg = llm.invoke(followup_messages)
    assistant_reply = (getattr(final_msg, "content", "") or "").strip()

    return {
        "assistantReply": assistant_reply,
        "stepsTextDelta": "\n".join(part.strip() for part in steps_outputs if part.strip()),
        "moveCalls": move_calls,
    }


def generate_payload(message: str, context: Dict[str, Any]) -> Dict[str, Any]:
    return _run_with_langchain(message, context)


def main() -> int:
    try:
        payload_in: Dict[str, Any] = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"Invalid JSON from stdin: {exc}\n")
        return 2

    message = _normalize_message_to_text(payload_in.get("message"))
    if not message:
        sys.stderr.write("message is required.\n")
        return 2

    context = _normalize_context(payload_in.get("context"))

    try:
        payload_out = generate_payload(message, context)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 1

    sys.stdout.write(json.dumps(payload_out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
