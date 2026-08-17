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
    "moveCalls": [...],
    "workspaceTransitions": [...],
    "currentDroplets": [...]
  }
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from typing import Any, Dict, List, Optional, Union

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
from move_backend import (
    GenerateDropletArray,
    Merge,
    Move,
    RotateMix,
    Split,
    SplitToArray,
    Squeeze,
    normalize_droplets_input,
)


def _runtime_model_options() -> Dict[str, Any]:
    thinking_mode = os.getenv("OPENAI_THINKING_MODE", "").strip()
    if thinking_mode in {"enabled", "disabled"}:
        return {"extra_body": {"thinking": {"type": thinking_mode}}}
    return {}


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


def _message_token_usage(message: Any) -> Dict[str, Any]:
    usage = getattr(message, "usage_metadata", None)
    if not isinstance(usage, dict):
        metadata = getattr(message, "response_metadata", None)
        usage = metadata.get("token_usage", {}) if isinstance(metadata, dict) else {}
    if not isinstance(usage, dict) or not usage:
        return {
            "available": False,
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
        }

    def safe_int(*names: str) -> int:
        for name in names:
            value = usage.get(name)
            if isinstance(value, (int, float)) and value >= 0:
                return int(value)
        return 0

    input_tokens = safe_int("input_tokens", "prompt_tokens")
    output_tokens = safe_int("output_tokens", "completion_tokens")
    return {
        "available": True,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": safe_int("total_tokens") or input_tokens + output_tokens,
    }


def _last_rects(sequence: List[Any], fallback: List[Any]) -> List[Any]:
    if not sequence:
        return list(fallback)
    last = sequence[-1]
    if isinstance(last, (list, tuple)) and len(last) > 1 and isinstance(last[1], list):
        return list(last[1])
    return list(fallback)


def _remove_consumed(current: List[Any], consumed: List[Any]) -> List[Any]:
    counts = Counter(tuple(rect) for rect in consumed)
    remaining = []
    for rect in current:
        key = tuple(rect)
        if counts[key] > 0:
            counts[key] -= 1
        else:
            remaining.append(rect)
    return remaining


def _merge_parallel_sequences(sequences: List[List[Any]]) -> List[Any]:
    if not sequences:
        return []
    max_len = max(len(sequence) for sequence in sequences)
    merged = []
    for step_index in range(max_len):
        rects = []
        for sequence in sequences:
            if not sequence:
                continue
            source_index = min(step_index, len(sequence) - 1)
            rects.extend(sequence[source_index][1])
        merged.append((step_index, rects))
    return merged


def _run_with_langchain(message: str, context: Dict[str, Any]) -> Dict[str, Any]:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
    from pydantic import BaseModel, Field

    selected_droplets = context.get("selectedDroplets", [])
    workspace_variables = dict(context.get("workspaceVariables", {}))

    class DropletModel(BaseModel):
        x: int
        y: int
        w: int
        h: int

    class WorkspaceVariableRef(BaseModel):
        workspaceVariable: str

    class GenerateArrayArgs(BaseModel):
        outputName: str
        x: int
        y: int
        w: int
        h: int
        count: Optional[int] = Field(default=None)
        gap: Optional[int] = Field(default=None)
        rows: Optional[int] = Field(default=None)
        columns: Optional[int] = Field(default=None)
        gapX: Optional[int] = Field(default=None)
        gapY: Optional[int] = Field(default=None)

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
        cycles: int
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(
            default=None
        )
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class SqueezeArgs(BaseModel):
        count: int
        direction: str
        droplets: Optional[Union[DropletModel, WorkspaceVariableRef]] = Field(
            default=None
        )
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class MergeArgs(BaseModel):
        droplets1: Union[List[DropletModel], WorkspaceVariableRef]
        droplets2: Union[List[DropletModel], WorkspaceVariableRef]

    class SplitArgs(BaseModel):
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(default=None)
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class SplitToArrayArgs(BaseModel):
        x: int
        y: int
        childW: int
        childH: int
        columns: int
        rows: int
        gapX: int
        gapY: int

    class InitializeDropletsArgs(BaseModel):
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(default=None)
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    @tool("generate_array", args_schema=GenerateArrayArgs)
    def generate_array(
        outputName: str,
        x: int,
        y: int,
        w: int,
        h: int,
        count: Optional[int] = None,
        gap: Optional[int] = None,
        rows: Optional[int] = None,
        columns: Optional[int] = None,
        gapX: Optional[int] = None,
        gapY: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Generate reusable positions; gap is origin spacing and must exceed width."""
        name = str(outputName).strip()
        if not name:
            raise ValueError("outputName must be non-empty.")
        if name in {"sequence", "currentFrameDroplets", "selectedDroplets"}:
            raise ValueError("outputName conflicts with a reserved workspace variable.")
        droplets = GenerateDropletArray(
            count, x, y, w, h, gap,
            rows=rows, columns=columns, gap_x=gapX, gap_y=gapY,
        )
        return {
            "kind": "workspace_update",
            "workspaceUpdates": {name: droplets},
            "workspaceVariable": name,
            "droplets": droplets,
        }

    request_started_empty = not normalize_droplets_input(
        workspace_variables.get("currentFrameDroplets", [])
    ) if workspace_variables.get("currentFrameDroplets") else True
    initialized_this_request = False
    sequence_operation_started = False

    @tool("initialize_droplets", args_schema=InitializeDropletsArgs)
    def initialize_droplets(
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Record pre-existing droplets as the initial workspace frame before operations begin."""
        nonlocal initialized_this_request
        if not request_started_empty:
            raise ValueError("initialization is only available when the request starts with an empty workspace.")
        if initialized_this_request or sequence_operation_started:
            raise ValueError("initialization must occur once before sequence operations.")
        resolved = _resolve_droplets(
            droplets=droplets, x=x, y=y, w=w, h=h,
            selected_droplets=[], workspace_variables=workspace_variables,
        )
        initialized_this_request = True
        return {
            "kind": "sequence",
            "sequence": [(0, resolved)],
            "resolvedDroplets": resolved,
            "consumedDroplets": [],
            "producedDroplets": resolved,
        }

    @tool("move", args_schema=MoveArgs)
    def move(
        direction: str,
        t: int,
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> Dict[str, Any]:
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
        operation_sequence = Move(resolved, direction, t)
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": resolved,
            "consumedDroplets": resolved,
            "producedDroplets": _last_rects(operation_sequence, resolved),
        }

    @tool("squeeze", args_schema=SqueezeArgs)
    def squeeze(
        count: int,
        direction: str,
        droplets: Optional[Union[DropletModel, WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Generate multiple droplets by extruding/squeezing from each source droplet.
        Source position/size, direction, and count are sufficient; no gap is
        needed because the squeeze template generates output positions itself.
        count is the requested squeeze output count and controls the template
        progression (1->6, 2->11, each extra +5); this is not a generic array.
        Accept one source droplet directly, from the current selection, or through
        a workspace variable. For multiple sources, call squeeze multiple times;
        the agent combines those paths by time step.
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
        if len(resolved) != 1:
            raise ValueError("squeeze accepts one source droplet per call; use multiple squeeze calls for multiple sources.")
        operation_sequence = Squeeze(resolved, count, direction)
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": resolved,
            "consumedDroplets": resolved,
            "producedDroplets": _last_rects(operation_sequence, []),
        }

    @tool("merge", args_schema=MergeArgs)
    def merge(
        droplets1: Union[List[DropletModel], WorkspaceVariableRef],
        droplets2: Union[List[DropletModel], WorkspaceVariableRef],
    ) -> Dict[str, Any]:
        """Merge droplets1[i] with droplets2[i] in parallel."""
        first = _resolve_droplets(
            droplets=droplets1, x=None, y=None, w=None, h=None,
            selected_droplets=[], workspace_variables=workspace_variables,
        )
        second = _resolve_droplets(
            droplets=droplets2, x=None, y=None, w=None, h=None,
            selected_droplets=[], workspace_variables=workspace_variables,
        )
        operation_sequence = Merge(first, second)
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": first + second,
            "consumedDroplets": first + second,
            "producedDroplets": _last_rects(operation_sequence, []),
        }

    @tool("rotate_mix", args_schema=RotateMixArgs)
    def rotate_mix(
        cycles: int,
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Generate circulation loops for one or more droplets.
        Each droplet uses its own width/height as the loop size.
        Droplets may be explicit, selected in the UI, or referenced from the workspace.
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
        operation_sequence = RotateMix(resolved, cycles)
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": resolved,
            "consumedDroplets": resolved,
            "producedDroplets": _last_rects(operation_sequence, resolved),
        }

    @tool("split", args_schema=SplitArgs)
    def split(
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        w: Optional[int] = None,
        h: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Split each droplet across its even long side and move halves apart."""
        resolved = _resolve_droplets(
            droplets=droplets, x=x, y=y, w=w, h=h,
            selected_droplets=selected_droplets,
            workspace_variables=workspace_variables,
        )
        operation_sequence = Split(resolved)
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": resolved,
            "consumedDroplets": resolved,
            "producedDroplets": _last_rects(operation_sequence, []),
        }

    @tool("split_to_array", args_schema=SplitToArrayArgs)
    def split_to_array(
        x: int,
        y: int,
        childW: int,
        childH: int,
        columns: int,
        rows: int,
        gapX: int,
        gapY: int,
    ) -> Dict[str, Any]:
        """Create one source droplet and recursively split it into a target grid."""
        operation_sequence = SplitToArray(
            x, y, childW, childH, columns, rows, gapX, gapY,
        )
        source = list(operation_sequence[0][1])
        return {
            "kind": "sequence",
            "sequence": operation_sequence,
            "resolvedDroplets": source,
            "consumedDroplets": source,
            "producedDroplets": _last_rects(operation_sequence, []),
        }

    model_name = os.getenv("OPENAI_MODEL") or LLM_MODEL
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        **_runtime_model_options(),
    )
    tool_registry = {
        "generate_array": generate_array,
        "initialize_droplets": initialize_droplets,
        "move": move,
        "merge": merge,
        "squeeze": squeeze,
        "rotate_mix": rotate_mix,
        "split": split,
        "split_to_array": split_to_array,
    }
    llm_with_tools = llm.bind_tools(list(tool_registry.values()))
    required_map = _build_required_map(tool_registry)
    token_usage = {
        "available": False,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
    }

    def invoke_with_usage(model: Any, invoke_messages: Any) -> Any:
        response = model.invoke(invoke_messages)
        usage = _message_token_usage(response)
        token_usage["available"] = token_usage["available"] or usage["available"]
        token_usage["inputTokens"] += usage["inputTokens"]
        token_usage["outputTokens"] += usage["outputTokens"]
        token_usage["totalTokens"] += usage["totalTokens"]
        return response

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
        reply_msg = invoke_with_usage(
            llm,
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
        reply_msg = invoke_with_usage(
            llm,
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
        "The workspace maintains the current droplet collection between tool rounds. After an operation, its produced droplets become the current droplets for the next dependent operation.\n"
        "For movement, call 'move'. To combine nearby droplets, call 'merge' with two equally sized arrays; droplets1[i] merges with droplets2[i]. For circulation mixing, call 'rotate_mix'.\n"
        "When the request starts with an empty workspace and refers to droplets that already exist before the requested operations, call 'initialize_droplets' once before all sequence operations to record their initial frame. Do not initialize a squeeze source. A generated coordinate array must be initialized before another operation consumes it.\n"
        "To split droplets, call 'split'. It divides each droplet across its long side and moves the equal halves apart; the long side must be even. For square droplets use the horizontal axis.\n"
        "For recursive division into a target grid, call 'split_to_array' with x/y, child size, rows, columns, gapX, and gapY. It derives the source size from child size and grid dimensions; rows and columns must each be powers of two. For independent grids, call it multiple times in the same round.\n"
        "For squeeze/extrusion generation, call 'squeeze' directly: source position, size, direction, and count are sufficient, and it internally generates the requested multiple droplets. NEVER ask for or invent an inter-droplet gap, and NEVER call 'generate_array' first for a squeeze/extrusion request.\n"
        "Squeeze is not a generic array operation: each squeeze call describes one source droplet. For multiple sources, call squeeze multiple times, even when their parameters match; the backend combines all squeeze paths by time step. No inter-droplet gap is needed.\n"
        "Use 'generate_array' only when the user explicitly asks for independent droplet positions/layout; after receiving its result, call another operation with a workspaceVariable reference to that name.\n"
        "A coordinate array is only a reusable coordinate collection, not an operation and not current droplets until an operation consumes it.\n"
        "When one operation depends on the result of another operation, wait for the tool result and make the dependent call in the next round; do not assume two dependent operations can run in parallel in one tool-call batch.\n"
        "When the UI provides selected droplets, operations may use them directly or explicitly reference the selectedDroplets workspace variable.\n"
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

    sequence_delta: List[Any] = []
    move_calls: List[Dict[str, Any]] = []
    workspace_updates: Dict[str, Any] = {}
    workspace_transitions: List[Dict[str, Any]] = []
    try:
        current_droplets = normalize_droplets_input(
            workspace_variables.get("currentFrameDroplets", [])
        )
    except Exception:  # noqa: BLE001
        current_droplets = []
    if not selected_droplets:
        selected_droplets = list(current_droplets)
    agent_messages: List[Any] = list(messages)
    assistant_reply = ""
    had_tool_calls = False

    for _ in range(8):
        ai_msg = invoke_with_usage(llm_with_tools, agent_messages)
        agent_messages.append(ai_msg)
        tool_calls = getattr(ai_msg, "tool_calls", None) or []
        if not tool_calls:
            assistant_reply = (getattr(ai_msg, "content", "") or "").strip()
            break

        had_tool_calls = True
        round_sequences: List[List[Any]] = []
        round_consumed: List[Any] = []
        round_produced: List[Any] = []
        for call in tool_calls:
            name = call.get("name")
            if name not in tool_registry:
                continue
            args = call.get("args", {})
            required = required_map.get(name, [])
            try:
                tool_result = tool_registry[name].invoke(args)
            except Exception as exc:  # noqa: BLE001
                return {
                    "assistantReply": _llm_generate_followup_for_tool_error(
                        name, required, args, f"{type(exc).__name__}: {exc}"
                    ),
                    "sequenceDelta": sequence_delta,
                    "moveCalls": move_calls,
                    "workspaceUpdates": workspace_updates,
                    "tokenUsage": token_usage,
                }

            result_kind = tool_result.get("kind")
            if result_kind == "workspace_update":
                updates = tool_result.get("workspaceUpdates", {})
                if isinstance(updates, dict):
                    workspace_variables.update(updates)
                    workspace_updates.update(updates)
            elif result_kind == "sequence":
                sequence_operation_started = True
                tool_sequence = tool_result.get("sequence", [])
                consumed = normalize_droplets_input(
                    tool_result.get("consumedDroplets", [])
                ) if tool_result.get("consumedDroplets") else []
                produced = normalize_droplets_input(
                    tool_result.get("producedDroplets", [])
                ) if tool_result.get("producedDroplets") else []
                round_sequences.append(tool_sequence)
                round_consumed.extend(consumed)
                round_produced.extend(produced)
                workspace_transitions.append(
                    {
                        "tool": name,
                        "consumedDroplets": consumed,
                        "producedDroplets": produced,
                    }
                )

            move_calls.append(
                {
                    "tool": name,
                    "args": args,
                    "resolvedDroplets": tool_result.get("resolvedDroplets", []),
                }
            )
            agent_messages.append(
                ToolMessage(
                    content=json.dumps(tool_result, ensure_ascii=False),
                    tool_call_id=call["id"],
                    name=name,
                )
            )

        if round_sequences:
            static_droplets = _remove_consumed(current_droplets, round_consumed)
            composed = _merge_parallel_sequences(round_sequences)
            for step_index, rects in composed:
                sequence_delta.append(
                    (step_index, rects + [rect for rect in static_droplets if rect not in rects])
                )
            current_droplets = static_droplets + round_produced
            workspace_variables["currentFrameDroplets"] = current_droplets
            selected_after = _remove_consumed(selected_droplets, round_consumed)
            if len(selected_after) != len(selected_droplets):
                selected_droplets = selected_after + round_produced
            elif not selected_droplets:
                selected_droplets = list(current_droplets)
    else:
        raise RuntimeError("LLM tool loop exceeded the maximum number of rounds.")

    if not assistant_reply:
        if not had_tool_calls:
            assistant_reply = _llm_generate_followup_for_no_toolcall(required_map)
        else:
            final_msg = invoke_with_usage(
                llm,
                [
                    *agent_messages,
                    HumanMessage(
                        content="请用一句中文回复用户你完成的动作和结果，不要输出代码块。"
                    ),
                ]
            )
            assistant_reply = (getattr(final_msg, "content", "") or "").strip()

    return {
        "assistantReply": assistant_reply,
        "sequenceDelta": sequence_delta,
        "moveCalls": move_calls,
        "workspaceUpdates": workspace_updates,
        "tokenUsage": token_usage,
        "workspaceTransitions": workspace_transitions,
        "currentDroplets": current_droplets,
        "selectedDroplets": selected_droplets,
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
