"""
LLM router:
Natural-language message + full context -> LLM tool call -> structured sequence delta.

Input (stdin JSON):
  {
    "message": "...",
    "context": {
      "sequence": [{"timeStep": 0, "duration": 1000, "rects": [...]}],
      "conversation": [{"role":"user|assistant","content":"..."}]
    }
  }

Output (stdout JSON):
  {
    "assistantReply": "...",
    "sequenceDelta": [[0, [[x, y, w, h]]], ...],
    "moveCalls": [...]
  }
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional, Union

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
from move_backend import (
    Move,
    MoveDroplets,
    RotateMix,
    RotateMixArrayDroplets,
    RotateMixDroplets,
    Squeeze,
    normalize_droplets_input,
)


def _normalize_message_to_text(message: Any) -> str:
    text = "" if message is None else str(message)
    return text.strip()


def _normalize_context(raw_context: Any) -> Dict[str, Any]:
    if not isinstance(raw_context, dict):
        return {
            "sequence": [],
            "workspaceVariables": {},
            "conversation": [],
            "selectedDroplets": [],
        }

    sequence = raw_context.get("sequence", [])
    if not isinstance(sequence, list):
        sequence = []

    workspace_variables = raw_context.get("workspaceVariables", {})
    if not isinstance(workspace_variables, dict):
        workspace_variables = {}

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
        "sequence": sequence,
        "workspaceVariables": workspace_variables,
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
    workspace_variables: Dict[str, Any],
) -> List[Any]:
    workspace_reference = None
    if isinstance(droplets, dict):
        workspace_reference = droplets.get("workspaceVariable")
    elif hasattr(droplets, "workspaceVariable"):
        workspace_reference = getattr(droplets, "workspaceVariable")

    has_explicit_single = any(value is not None for value in (x, y, w, h))
    if workspace_reference is not None:
        if has_explicit_single:
            raise ValueError("cannot combine a workspace variable with x/y/w/h.")
        name = str(workspace_reference).strip()
        if not name or name not in workspace_variables:
            raise ValueError("referenced workspace variable is not available.")
        return normalize_droplets_input(workspace_variables[name])
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

    class WorkspaceVariableRef(BaseModel):
        workspaceVariable: str

    class DropletArrayModel(BaseModel):
        count: int
        x: int
        y: int
        w: int
        h: int
        gap: int

    class MoveArgs(BaseModel):
        direction: str
        t: int
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(
            default=None
        )
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class RotateMixArgs(BaseModel):
        duration: int
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(
            default=None
        )
        array: Optional[DropletArrayModel] = Field(default=None)
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

    @tool("move", args_schema=MoveArgs)
    def move(
        direction: str,
        t: int,
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> List[Any]:
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
            workspace_variables=workspace_variables,
        )
        if len(resolved) == 1:
            return Move(resolved[0], direction, t)
        return MoveDroplets(resolved, direction, t)

    @tool("squeeze", args_schema=SqueezeArgs)
    def squeeze(count: int, x: int, y: int, direction: str, size: str) -> List[Any]:
        """
        Generate squeezing sequence from template.
        count controls truncation (1->6, 2->11, each extra +5).
        x,y are translation offsets; direction controls rotation.
        size supports both uniform and non-uniform scaling:
        e.g. "2" or "3*2" (also supports "3x2").
        """
        return Squeeze(count, x, y, direction, size=size)

    @tool("rotate_mix", args_schema=RotateMixArgs)
    def rotate_mix(
        duration: int,
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        array: Optional[DropletArrayModel] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> List[Any]:
        """
        Generate circulation loops for one or more droplets, including an array layout.
        Each droplet uses its own width/height as the loop size.
        Provide exactly one input mode: an array description, droplets, one droplet via
        x/y/w/h, or the current UI selection. Arrays use a near-square,
        row-major layout; the standard gap is 4 and must be explicit.
        """
        has_direct_input = droplets is not None or any(
            value is not None for value in (x, y, w, h)
        )
        if array is not None and has_direct_input:
            raise ValueError("cannot combine array with droplets or x/y/w/h.")
        if array is not None:
            if isinstance(array, dict):
                values = array
            elif hasattr(array, "model_dump"):
                values = array.model_dump()
            else:
                values = array.dict()
            resolved = RotateMixArrayDroplets(
                values["count"],
                duration,
                size=(values["w"], values["h"]),
                gap=values["gap"],
                origin_x=values["x"],
                origin_y=values["y"],
            )
        else:
            resolved = _resolve_droplets(
                droplets=droplets,
                x=x,
                y=y,
                w=w,
                h=h,
                selected_droplets=selected_droplets,
                workspace_variables=workspace_variables,
            )
        if len(resolved) == 1:
            x0, y0, w0, h0 = resolved[0]
            return RotateMix(x0, y0, duration, size=(w0, h0))
        return RotateMixDroplets(resolved, duration)

    model_name = os.getenv("OPENAI_MODEL") or LLM_MODEL
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
    )
    tool_registry = {"move": move, "squeeze": squeeze, "rotate_mix": rotate_mix}
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
        "You have FULL context of prior conversation and the backend sequence workspace.\n"
        "For movement, call tool 'move'. For squeeze generation, call tool 'squeeze'. For circulation mixing, including array layouts, call tool 'rotate_mix'.\n"
        "When the UI provides selected droplets, you may use them by calling move/rotate_mix without x/y/w/h.\n"
        "Tool arguments may explicitly reference an available workspace variable using {\"workspaceVariable\": \"variableName\"}.\n"
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

    sequence = context.get("sequence", [])
    workspace_variables = context.get("workspaceVariables", {})
    selected_text = (
        json.dumps(selected_droplets, ensure_ascii=False)
        if selected_droplets
        else "[EMPTY]"
    )
    messages.append(
        HumanMessage(
            content=(
                "以下是当前已经存储的完整结构化激活序列（可能为空）：\n"
                f"{json.dumps(sequence, ensure_ascii=False) if sequence else '[EMPTY]'}\n\n"
                "以下是工具参数可引用的工作空间变量：\n"
                f"{json.dumps(workspace_variables, ensure_ascii=False)}\n\n"
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
            "sequenceDelta": [],
            "moveCalls": [],
        }

    tool_messages: List[ToolMessage] = []
    sequence_delta: List[Any] = []
    move_calls: List[Dict[str, Any]] = []
    for call in tool_calls:
        name = call.get("name")
        if name not in tool_registry:
            continue
        args = call.get("args", {})
        required = required_map.get(name, [])
        try:
            if name == "move":
                tool_result = move.invoke(args)
            elif name == "squeeze":
                tool_result = squeeze.invoke(args)
            else:
                tool_result = rotate_mix.invoke(args)
        except Exception as exc:  # noqa: BLE001
            return {
                "assistantReply": _llm_generate_followup_for_tool_error(
                    name, required, args, f"{type(exc).__name__}: {exc}"
                ),
                "sequenceDelta": [],
                "moveCalls": [],
            }
        sequence_delta.extend(tool_result)
        resolved_droplets: List[Any] = []
        if name in ("move", "rotate_mix"):
            if name == "rotate_mix" and args.get("array") is not None:
                array_value = args["array"]
                resolved_droplets = RotateMixArrayDroplets(
                    array_value["count"],
                    args["duration"],
                    size=(array_value["w"], array_value["h"]),
                    gap=array_value["gap"],
                    origin_x=array_value["x"],
                    origin_y=array_value["y"],
                )
            else:
                resolved_droplets = _resolve_droplets(
                    droplets=args.get("droplets"),
                    x=args.get("x"),
                    y=args.get("y"),
                    w=args.get("w"),
                    h=args.get("h"),
                    selected_droplets=selected_droplets,
                    workspace_variables=workspace_variables,
                )
        move_calls.append(
            {"tool": name, "args": args, "resolvedDroplets": resolved_droplets}
        )
        tool_messages.append(
            ToolMessage(
                content=json.dumps(tool_result, ensure_ascii=False),
                tool_call_id=call["id"],
                name=name,
            )
        )

    if not sequence_delta:
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
        "sequenceDelta": sequence_delta,
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
