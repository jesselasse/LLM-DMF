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
    GenerateDropletArray,
    Merge,
    Move,
    RotateMix,
    Squeeze,
    merge_sequences_by_step,
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


def _last_sequence_rects(sequence: Any) -> List[Any]:
    if not isinstance(sequence, list) or not sequence:
        return []
    last = sequence[-1]
    if isinstance(last, (list, tuple)) and len(last) > 1:
        return list(last[1]) if isinstance(last[1], list) else []
    if isinstance(last, dict):
        return list(last.get("rects", [])) if isinstance(last.get("rects"), list) else []
    return []


def _with_output_variable(
    result: Dict[str, Any], output_name: Optional[str]
) -> Dict[str, Any]:
    name = str(output_name or "").strip()
    if not name:
        return result
    if name in {"sequence", "currentFrameDroplets", "selectedDroplets"}:
        raise ValueError("outputName conflicts with a reserved workspace variable.")
    result["workspaceUpdates"] = {name: _last_sequence_rects(result.get("sequence", []))}
    result["workspaceVariable"] = name
    return result


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
        count: int
        x: int
        y: int
        w: int
        h: int
        gap: int

    class MoveArgs(BaseModel):
        direction: str
        t: int
        outputName: Optional[str] = Field(default=None)
        droplets: Optional[Union[List[DropletModel], WorkspaceVariableRef]] = Field(
            default=None
        )
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class RotateMixArgs(BaseModel):
        duration: int
        outputName: Optional[str] = Field(default=None)
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
        outputName: Optional[str] = Field(default=None)
        droplets: Optional[Union[DropletModel, WorkspaceVariableRef]] = Field(
            default=None
        )
        x: Optional[int] = Field(default=None)
        y: Optional[int] = Field(default=None)
        w: Optional[int] = Field(default=None)
        h: Optional[int] = Field(default=None)

    class MergeArgs(BaseModel):
        outputName: Optional[str] = Field(default=None)
        droplets1: Union[List[DropletModel], WorkspaceVariableRef]
        droplets2: Union[List[DropletModel], WorkspaceVariableRef]

    @tool("generate_array", args_schema=GenerateArrayArgs)
    def generate_array(
        outputName: str,
        count: int,
        x: int,
        y: int,
        w: int,
        h: int,
        gap: int,
    ) -> Dict[str, Any]:
        """Generate reusable droplet positions and store them in a workspace variable."""
        name = str(outputName).strip()
        if not name:
            raise ValueError("outputName must be non-empty.")
        if name in {"sequence", "currentFrameDroplets", "selectedDroplets"}:
            raise ValueError("outputName conflicts with a reserved workspace variable.")
        droplets = GenerateDropletArray(count, x, y, w, h, gap)
        return {
            "kind": "workspace_update",
            "workspaceUpdates": {name: droplets},
            "workspaceVariable": name,
            "droplets": droplets,
        }

    @tool("move", args_schema=MoveArgs)
    def move(
        direction: str,
        t: int,
        outputName: Optional[str] = None,
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
        return _with_output_variable({
            "kind": "sequence",
            "sequence": Move(resolved, direction, t),
            "resolvedDroplets": resolved,
        }, outputName)

    @tool("squeeze", args_schema=SqueezeArgs)
    def squeeze(
        count: int,
        direction: str,
        outputName: Optional[str] = None,
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
        return _with_output_variable({
            "kind": "sequence",
            "sequence": Squeeze(resolved, count, direction),
            "resolvedDroplets": resolved,
        }, outputName)

    @tool("merge", args_schema=MergeArgs)
    def merge(
        droplets1: Union[List[DropletModel], WorkspaceVariableRef],
        droplets2: Union[List[DropletModel], WorkspaceVariableRef],
        outputName: Optional[str] = None,
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
        return _with_output_variable({
            "kind": "sequence",
            "sequence": Merge(first, second),
            "resolvedDroplets": first + second,
        }, outputName)

    @tool("rotate_mix", args_schema=RotateMixArgs)
    def rotate_mix(
        duration: int,
        outputName: Optional[str] = None,
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
        return _with_output_variable({
            "kind": "sequence",
            "sequence": RotateMix(resolved, duration),
            "resolvedDroplets": resolved,
        }, outputName)

    model_name = os.getenv("OPENAI_MODEL") or LLM_MODEL
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
    )
    tool_registry = {
        "generate_array": generate_array,
        "move": move,
        "merge": merge,
        "squeeze": squeeze,
        "rotate_mix": rotate_mix,
    }
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
        "For movement, call 'move'. To combine nearby droplets, call 'merge' with two equally sized arrays; droplets1[i] merges with droplets2[i]. For circulation mixing, call 'rotate_mix'.\n"
        "For squeeze/extrusion generation, call 'squeeze' directly: source position, size, direction, and count are sufficient, and it internally generates the requested multiple droplets. NEVER ask for or invent an inter-droplet gap, and NEVER call 'generate_array' first for a squeeze/extrusion request.\n"
        "Squeeze is not a generic array operation: each squeeze call describes one source droplet. For multiple sources, call squeeze multiple times, even when their parameters match; the backend combines all squeeze paths by time step. No inter-droplet gap is needed.\n"
        "Use 'generate_array' only when the user explicitly asks for independent droplet positions/layout; after receiving its result, call another operation with a workspaceVariable reference to that name.\n"
        "When the UI provides selected droplets, operations may use them directly or explicitly reference the selectedDroplets workspace variable.\n"
        "Tool arguments may explicitly reference an available workspace variable using {\"workspaceVariable\": \"variableName\"}.\n"
        "Sequence operations may provide outputName to save their resulting droplet collection in the workspace; reusing an existing outputName replaces that variable. Use the saved result for later move, merge, or rotate_mix calls instead of guessing coordinates.\n"
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
    sequence_tool_names: List[str] = []
    squeeze_sequences: List[Any] = []
    agent_messages: List[Any] = list(messages)
    assistant_reply = ""
    had_tool_calls = False

    for _ in range(8):
        ai_msg = llm_with_tools.invoke(agent_messages)
        agent_messages.append(ai_msg)
        tool_calls = getattr(ai_msg, "tool_calls", None) or []
        if not tool_calls:
            assistant_reply = (getattr(ai_msg, "content", "") or "").strip()
            break

        had_tool_calls = True
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
                }

            result_kind = tool_result.get("kind")
            if result_kind == "workspace_update":
                updates = tool_result.get("workspaceUpdates", {})
                if isinstance(updates, dict):
                    workspace_variables.update(updates)
                    workspace_updates.update(updates)
            elif result_kind == "sequence":
                tool_sequence = tool_result.get("sequence", [])
                sequence_tool_names.append(name)
                if name == "squeeze":
                    squeeze_sequences.append(tool_sequence)
                else:
                    sequence_delta.extend(tool_sequence)

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
    else:
        raise RuntimeError("LLM tool loop exceeded the maximum number of rounds.")

    if not assistant_reply:
        if not had_tool_calls:
            assistant_reply = _llm_generate_followup_for_no_toolcall(required_map)
        else:
            final_msg = llm.invoke(
                [
                    *agent_messages,
                    HumanMessage(
                        content="请用一句中文回复用户你完成的动作和结果，不要输出代码块。"
                    ),
                ]
            )
            assistant_reply = (getattr(final_msg, "content", "") or "").strip()

    if squeeze_sequences:
        if all(name == "squeeze" for name in sequence_tool_names):
            sequence_delta = merge_sequences_by_step(squeeze_sequences)
        else:
            sequence_delta.extend(merge_sequences_by_step(squeeze_sequences))

    return {
        "assistantReply": assistant_reply,
        "sequenceDelta": sequence_delta,
        "moveCalls": move_calls,
        "workspaceUpdates": workspace_updates,
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
