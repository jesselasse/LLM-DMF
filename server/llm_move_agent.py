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


def _tool_required_args(tool_obj: Any) -> List[str]:
    """
    Read required args from tool schema dynamically.
    Works across pydantic v1/v2 style schemas.
    """
    args_schema = getattr(tool_obj, "args_schema", None)
    schema: Dict[str, Any] = {}
    if args_schema is not None:
        if hasattr(args_schema, "model_json_schema"):
            schema = args_schema.model_json_schema() or {}
        elif hasattr(args_schema, "schema"):
            schema = args_schema.schema() or {}

    required = schema.get("required")
    if isinstance(required, list) and required:
        return [str(name) for name in required]

    properties = schema.get("properties")
    if isinstance(properties, dict) and properties:
        return list(properties.keys())

    args = getattr(tool_obj, "args", None)
    if isinstance(args, dict) and args:
        return list(args.keys())

    return []


def _build_required_map(tool_registry: Dict[str, Any]) -> Dict[str, List[str]]:
    return {name: _tool_required_args(tool_obj) for name, tool_obj in tool_registry.items()}


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
    def squeeze(count: int, x: int, y: int, direction: str, size: str ) -> str:
        """
        Generate squeezing sequence from template.
        count controls truncation (1->6, 2->11, each extra +5).
        x,y are translation offsets; direction controls rotation.
        size supports both uniform and non-uniform scaling:
        e.g. "2" or "3*2" (also supports "3x2").
        """
        return Squeeze_as_txt(count, x, y, direction, size=size)

    model_name = os.getenv("OPENAI_MODEL", LLM_MODEL)
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
    )
    tool_registry = {"move": move, "squeeze": squeeze}
    llm_with_tools = llm.bind_tools(list(tool_registry.values()))
    required_map = _build_required_map(tool_registry)
    
    def _llm_generate_followup_for_tool_error(
        tool_name: str, required: List[str], args: Any, error_text: str
    ) -> str:
        from langchain_core.messages import HumanMessage, SystemMessage

        prompt = (
            "你是一个DMF助手。工具调用失败了，请生成一条中文追问给用户。\n"
            "只输出用户可读的一句话，不要技术实现细节。\n"
            "禁止出现：函数名、工具名、参数名、括号、等号、代码片段。\n"
            f"函数名: {tool_name}\n"
            f"必填参数: {required}\n"
            f"当前工具参数: {args}\n"
            f"报错信息: {error_text}\n"
            "如果看起来是缺参数，就只问用户缺什么；可提醒用户可用默认值，但不要写成实现语句。"
        )
        reply_msg = llm.invoke(
            [
                SystemMessage(content="You generate concise Chinese follow-up questions."),
                HumanMessage(content=prompt),
            ]
        )
        reply = (getattr(reply_msg, "content", "") or "").strip()
        if not reply:
            raise RuntimeError("LLM returned empty follow-up for tool error.")
        return reply

    def _llm_generate_followup_for_no_toolcall(required_map_data: Dict[str, List[str]]) -> str:
        from langchain_core.messages import HumanMessage, SystemMessage

        prompt = (
            "你是一个DMF助手。用户刚刚发来请求，但模型没有触发工具调用。\n"
            "请生成一条中文追问，要求用户补齐动作所需要的信息。\n"
            "只输出用户可读的一句话，不要技术实现细节。\n"
            "禁止出现：函数名、工具名、参数名、括号、等号、代码片段。\n"
            f"当前可用函数及必填参数: {required_map_data}\n"
        )
        reply_msg = llm.invoke(
            [
                SystemMessage(content="You generate concise Chinese follow-up questions."),
                HumanMessage(content=prompt),
            ]
        )
        reply = (getattr(reply_msg, "content", "") or "").strip()
        if not reply:
            raise RuntimeError("LLM returned empty follow-up when no tool call is produced.")
        return reply

    system_prompt = (
        "You are a DMF workflow planner.\n"
        "You have FULL context of prior conversation and the FULL stored sequence text.\n"
        "For movement, call tool 'move'. For generation requests, call tool 'squeeze'.\n"
        "When information is insufficient, ask a follow-up question instead of calling tools.\n"
        "You may suggest defaults, but must ask user confirmation before applying them.\n"
        "If there are multiple droplets and request is ambiguous, ask clarification and do not call tools.\n"
        "Never reveal tool/function names, parameter names, or implementation details to the user.\n"
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
                "你现在只需要在这个基础上处理新请求，并生成新增步骤。\n"
                f"新请求：{message}"
            )
        )
    )

    ai_msg = llm_with_tools.invoke(messages)
    tool_calls = getattr(ai_msg, "tool_calls", None) or []

    if not tool_calls:
        reply = (getattr(ai_msg, "content", "") or "").strip()
        if not reply:
            reply = _llm_generate_followup_for_no_toolcall(required_map)
        return {
            "assistantReply": reply,
            "stepsTextDelta": "",
            "moveCalls": [],
        }

    tool_messages: List[ToolMessage] = []
    steps_outputs: List[str] = []
    move_calls: List[Dict[str, Any]] = []

    for call in tool_calls:
        name = call.get("name")
        if name not in ("move", "squeeze"):
            continue
        args = call.get("args", {})
        required = required_map.get(name, [])
        try:
            if name == "move":
                tool_result = move.invoke(args)
            else:
                tool_result = squeeze.invoke(args)
        except Exception as exc:  # noqa: BLE001
            return {
                "assistantReply": _llm_generate_followup_for_tool_error(
                    name, required, args, f"{type(exc).__name__}: {exc}"
                ),
                "stepsTextDelta": "",
                "moveCalls": [],
            }
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
        raise RuntimeError("No executable tool output produced from tool calls.")

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
