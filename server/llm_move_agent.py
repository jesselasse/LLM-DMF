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
from typing import Any, Dict, List, Optional

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
from move_backend import (
    MoveDroplets_as_txt,
    Move_as_txt,
    RotateMixArray_as_txt,
    RotateMixDroplets_as_txt,
    RotateMix_as_txt,
    Squeeze_as_txt,
    normalize_droplets_input,
)


def _normalize_message_to_text(message: Any) -> str:
    text = "" if message is None else str(message)
    return text.strip()


def _normalize_context(raw_context: Any) -> Dict[str, Any]:
    if not isinstance(raw_context, dict):
        return {"sequenceText": "", "conversation": [], "selectedDroplets": []}

    sequence_text = raw_context.get("sequenceText", "")
    if not isinstance(sequence_text, str):
        sequence_text = str(sequence_text or "")

    conversation = raw_context.get("conversation", [])
    if not isinstance(conversation, list):
        conversation = []

    selected_droplets = raw_context.get("selectedDroplets", [])
    try:
        normalized_selected_droplets = normalize_droplets_input(selected_droplets)
    except Exception:  # noqa: BLE001
        normalized_selected_droplets = []

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
        "selectedDroplets": normalized_selected_droplets,
    }


def _normalize_optional_int(value: Any, name: str) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be int.") from exc


def _resolve_droplets(
    *,
    droplets: Any,
    x: Any,
    y: Any,
    w: Any,
    h: Any,
    selected_droplets: List[Any],
) -> List[Any]:
    has_explicit_single = any(value is not None for value in (x, y, w, h))
    if droplets is not None and has_explicit_single:
        raise ValueError("cannot provide both droplets and x/y/w/h.")
    if droplets is not None:
        return normalize_droplets_input(droplets)
    if has_explicit_single:
        values = {
            "x": _normalize_optional_int(x, "x"),
            "y": _normalize_optional_int(y, "y"),
            "w": _normalize_optional_int(w, "w"),
            "h": _normalize_optional_int(h, "h"),
        }
        missing = [name for name, value in values.items() if value is None]
        if missing:
            raise ValueError(
                f"single droplet input is incomplete; missing: {', '.join(missing)}."
            )
        return normalize_droplets_input([values])
    if selected_droplets:
        return normalize_droplets_input(selected_droplets)
    raise ValueError(
        "droplet input is required; provide droplets, provide x/y/w/h, or select droplets in the UI."
    )


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
    from pydantic import BaseModel, Field

    selected_droplets = context.get("selectedDroplets", [])

    class DropletModel(BaseModel):
        x: int
        y: int
        w: int
        h: int

    class MoveArgs(BaseModel):
        direction: str
        t: int
        droplets: Optional[List[DropletModel]] = Field(default=None)
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class RotateMixArgs(BaseModel):
        duration: int
        droplets: Optional[List[DropletModel]] = Field(default=None)
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class SqueezeArgs(BaseModel):
        count: int
        x: int
        y: int
        direction: str
        size: str

    class RotateMixArrayArgs(BaseModel):
        count: int
        duration: int
        size: str = "1*2"

    @tool("move", args_schema=MoveArgs)
    def move(
        direction: str,
        t: int,
        droplets: Optional[List[DropletModel]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> str:
        """
        Move one or more droplets along direction by t grid steps.
        You may provide a droplets list directly, or one droplet via x/y/w/h.
        If neither is provided, the currently selected UI droplets may be used.
        """
        resolved = _resolve_droplets(
            droplets=droplets,
            x=x,
            y=y,
            w=w,
            h=h,
            selected_droplets=selected_droplets,
        )
        if len(resolved) == 1:
            return Move_as_txt(resolved[0], direction, t)
        return MoveDroplets_as_txt(resolved, direction, t)

    @tool("squeeze", args_schema=SqueezeArgs)
    def squeeze(count: int, x: int, y: int, direction: str, size: str) -> str:
        """
        Generate squeezing sequence from template.
        count controls truncation (1->6, 2->11, each extra +5).
        x,y are translation offsets; direction controls rotation.
        size supports both uniform and non-uniform scaling:
        e.g. "2" or "3*2" (also supports "3x2").
        """
        return Squeeze_as_txt(count, x, y, direction, size=size)

    @tool("rotate_mix", args_schema=RotateMixArgs)
    def rotate_mix(
        duration: int,
        droplets: Optional[List[DropletModel]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> str:
        """
        Generate circulation loops for one or more droplets.
        Each droplet uses its own width/height as the loop size.
        You may provide droplets directly, one droplet via x/y/w/h, or rely on UI selection.
        """
        resolved = _resolve_droplets(
            droplets=droplets,
            x=x,
            y=y,
            w=w,
            h=h,
            selected_droplets=selected_droplets,
        )
        if len(resolved) == 1:
            x0, y0, w0, h0 = resolved[0]
            return RotateMix_as_txt(x0, y0, duration, size=(w0, h0))
        return RotateMixDroplets_as_txt(resolved, duration)

    @tool("rotate_mix_array", args_schema=RotateMixArrayArgs)
    def rotate_mix_array(count: int, duration: int, size: str = "1*2") -> str:
        """
        Generate an array of rotate-mix modules.
        The array uses default gap 4 and fills row by row using a near-square layout.
        For example: 16 -> 4x4, 12 -> 4x3, 11 -> 4x3 with the last slot left unused, 25 -> 5x5.
        The base module is anchored at (0,0).
        """
        return RotateMixArray_as_txt(count, duration, size=size, gap=4)

    model_name = os.getenv("OPENAI_MODEL", LLM_MODEL)
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
    )
    tool_registry = {"move": move, "squeeze": squeeze, "rotate_mix": rotate_mix, "rotate_mix_array": rotate_mix_array}
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
        "For movement, call tool 'move'. For squeeze generation, call tool 'squeeze'. For single circulation mixing, call tool 'rotate_mix'. For arrayed circulation mixing, call tool 'rotate_mix_array'.\n"
        "When the UI provides selected droplets, you may use them by calling move/rotate_mix without x/y/w/h.\n"
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
    selected_text = (
        json.dumps(selected_droplets, ensure_ascii=False)
        if selected_droplets
        else "[EMPTY]"
    )
    messages.append(
        HumanMessage(
            content=(
                "以下是当前已经存储的完整激活序列（可能为空）：\n"
                f"{sequence_text if sequence_text.strip() else '[EMPTY]'}\n\n"
                "以下是当前UI里选中的液滴列表（可能为空）：\n"
                f"{selected_text}\n\n"
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
        if name not in ("move", "squeeze", "rotate_mix", "rotate_mix_array"):
            continue
        args = call.get("args", {})
        required = required_map.get(name, [])
        try:
            if name == "move":
                tool_result = move.invoke(args)
            elif name == "squeeze":
                tool_result = squeeze.invoke(args)
            elif name == "rotate_mix":
                tool_result = rotate_mix.invoke(args)
            else:
                tool_result = rotate_mix_array.invoke(args)
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
