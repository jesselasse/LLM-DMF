from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any, Dict, List, Literal, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field


def runtime_model_options() -> Dict[str, Any]:
    thinking_mode = os.environ.get("OPENAI_THINKING_MODE", "").strip()
    if thinking_mode in {"enabled", "disabled"}:
        return {"extra_body": {"thinking": {"type": thinking_mode}}}
    return {}


class StepDraft(BaseModel):
    prompt: str
    expectedOperation: str = ""
    expectedParameters: str = ""
    notes: str = ""


class ExperimentDraft(BaseModel):
    category: str = ""
    mode: Literal["complete", "default", "multi"] = "complete"
    repeats: int = Field(default=1, ge=1, le=100)
    notes: str = ""
    steps: List[StepDraft]


class MergeSeriesRequest(BaseModel):
    category: str
    experimentCount: int = Field(ge=1, le=100)
    repeats: int = Field(ge=1, le=100)
    mergeKind: Literal["pair", "multi"]
    gridRows: int = Field(ge=1, le=1000)
    gridCols: int = Field(ge=1, le=1000)
    seed: str
    sizeMin: int = Field(ge=1, le=100)
    sizeMax: int = Field(ge=1, le=100)
    gapMin: int = Field(ge=0, le=1000)
    gapMax: int = Field(ge=0, le=1000)
    pairsMin: int = Field(ge=1, le=200)
    pairsMax: int = Field(ge=1, le=200)
    axes: Literal["horizontal", "vertical", "balanced", "random"]
    promptTemplate: str
    notes: str = ""


class DesignerResponse(BaseModel):
    assistantReply: str
    needsInput: bool
    project: Optional[List[ExperimentDraft]] = None
    projectName: str = ""
    mergeSeries: List[MergeSeriesRequest] = Field(default_factory=list)
    requestedExperimentCount: Optional[int] = Field(default=None, ge=1, le=200)
    requestedTotalRuns: Optional[int] = Field(default=None, ge=1, le=20000)
    requestedCategoryCounts: Dict[str, int] = Field(default_factory=dict)


def validate_project_structure(
    project: Dict[str, Any],
    requested_experiment_count: Optional[int] = None,
    requested_total_runs: Optional[int] = None,
    requested_category_counts: Optional[Dict[str, int]] = None,
) -> None:
    experiments = project.get("experiments") or []
    if not experiments or len(experiments) > 200:
        raise ValueError("Experiment draft must contain between 1 and 200 experiments.")
    for index, experiment in enumerate(experiments, start=1):
        mode = experiment.get("mode") or "complete"
        steps = experiment.get("steps") or []
        if not steps or len(steps) > 100:
            raise ValueError(
                f"Experiment {index} must contain between 1 and 100 steps."
            )
        if mode == "multi" and len(steps) < 2:
            raise ValueError(
                f"Experiment {index} uses multi mode but has fewer than 2 steps."
            )
        if mode != "multi" and len(steps) != 1:
            raise ValueError(
                f"Experiment {index} uses {mode} mode and must contain exactly 1 step. "
                "Independent Prompt variations must be separate experiments."
            )
        for step in steps:
            if len(str(step.get("prompt") or "")) > 20000:
                raise ValueError(f"A Prompt in experiment {index} is too long.")
    actual_experiment_count = len(experiments)
    actual_total_runs = sum(int(experiment.get("repeats") or 1) for experiment in experiments)
    actual_category_counts: Dict[str, int] = {}
    for experiment in experiments:
        category = str(experiment.get("category") or "").strip()
        actual_category_counts[category] = actual_category_counts.get(category, 0) + 1
    if requested_experiment_count is not None and requested_experiment_count != actual_experiment_count:
        raise ValueError(
            "Requested experiment count does not match the submitted project: "
            f"required {requested_experiment_count}, submitted {actual_experiment_count}."
        )
    if requested_total_runs is not None and requested_total_runs != actual_total_runs:
        raise ValueError(
            "Requested total run count does not match the submitted project: "
            f"required {requested_total_runs}, submitted {actual_total_runs}."
        )
    for category, required_count in (requested_category_counts or {}).items():
        actual_count = actual_category_counts.get(str(category).strip(), 0)
        if actual_count != required_count:
            raise ValueError(
                f"Requested category count for {category!r} is {required_count}, "
                f"but the submitted project contains {actual_count}."
            )


class UniformSampler:
    def __init__(self, seed: str) -> None:
        self.seed = str(seed).encode("utf-8")
        self.counter = 0

    def integer(self, minimum: int, maximum: int) -> int:
        if minimum > maximum:
            raise ValueError("Random integer range has minimum greater than maximum.")
        span = maximum - minimum + 1
        limit = (1 << 256) - ((1 << 256) % span)
        while True:
            digest = hashlib.sha256(
                self.seed + b":" + str(self.counter).encode("ascii")
            ).digest()
            self.counter += 1
            value = int.from_bytes(digest, "big")
            if value < limit:
                return minimum + value % span

    def shuffle(self, values: List[int]) -> None:
        for index in range(len(values) - 1, 0, -1):
            target = self.integer(0, index)
            values[index], values[target] = values[target], values[index]


def _rect_text(rect: Dict[str, int]) -> str:
    return f"{rect['x']},{rect['y']},{rect['w']},{rect['h']}"


def _prompt_rect(rect: Dict[str, int]) -> str:
    return f"位置 ({rect['x']},{rect['y']})、尺寸 {rect['w']}×{rect['h']}"


def _render_prompt_template(template: str, values: Dict[str, str], required: List[str]) -> str:
    text = str(template or "").strip()
    for name in required:
        if "{" + name + "}" not in text:
            raise ValueError(f"Prompt template is missing {{{name}}}.")
    for name, value in values.items():
        text = text.replace("{" + name + "}", value)
    if "{" in text or "}" in text:
        raise ValueError("Prompt template contains an unsupported placeholder.")
    return text


def _axis_for(request: MergeSeriesRequest, sampler: UniformSampler, index: int) -> str:
    if request.axes == "horizontal":
        return "horizontal"
    if request.axes == "vertical":
        return "vertical"
    if request.axes == "balanced":
        return "horizontal" if index % 2 == 0 else "vertical"
    return "horizontal" if sampler.integer(0, 1) == 0 else "vertical"


def _size(request: MergeSeriesRequest, sampler: UniformSampler) -> Dict[str, int]:
    return {
        "w": sampler.integer(request.sizeMin, request.sizeMax),
        "h": sampler.integer(request.sizeMin, request.sizeMax),
    }


def build_merge_series(request: MergeSeriesRequest) -> List[Dict[str, Any]]:
    if request.sizeMin > request.sizeMax:
        raise ValueError("sizeMin must not exceed sizeMax.")
    if request.gapMin > request.gapMax:
        raise ValueError("gapMin must not exceed gapMax.")
    if request.pairsMin > request.pairsMax:
        raise ValueError("pairsMin must not exceed pairsMax.")
    if request.mergeKind == "pair" and (request.pairsMin != 1 or request.pairsMax != 1):
        raise ValueError("Pair merge series must use pairsMin=1 and pairsMax=1.")
    sampler = UniformSampler(request.seed)
    tile_size = request.sizeMax * 2 + request.gapMax + 2
    tile_columns = request.gridCols // tile_size
    tile_rows = request.gridRows // tile_size
    capacity = tile_columns * tile_rows
    if request.mergeKind == "multi" and request.pairsMax > capacity:
        raise ValueError(
            f"The requested grid can safely place at most {capacity} merge pairs "
            "with the supplied size and gap ranges."
        )
    experiments: List[Dict[str, Any]] = []
    for experiment_index in range(request.experimentCount):
        pair_count = (
            1
            if request.mergeKind == "pair"
            else sampler.integer(request.pairsMin, request.pairsMax)
        )
        first_group: List[Dict[str, int]] = []
        second_group: List[Dict[str, int]] = []
        if request.mergeKind == "pair":
            slots = [0]
        else:
            slots = list(range(capacity))
            sampler.shuffle(slots)
            slots = slots[:pair_count]
        for pair_index, slot in enumerate(slots):
            first_size = _size(request, sampler)
            second_size = _size(request, sampler)
            gap = sampler.integer(request.gapMin, request.gapMax)
            axis = _axis_for(request, sampler, experiment_index + pair_index)
            if request.mergeKind == "pair":
                if axis == "horizontal":
                    max_x = request.gridCols - first_size["w"] - second_size["w"] - gap
                    max_y = request.gridRows - max(first_size["h"], second_size["h"])
                else:
                    max_x = request.gridCols - max(first_size["w"], second_size["w"])
                    max_y = request.gridRows - first_size["h"] - second_size["h"] - gap
                if max_x < 0 or max_y < 0:
                    raise ValueError("The grid is too small for the requested merge ranges.")
                base_x = sampler.integer(0, max_x)
                base_y = sampler.integer(0, max_y)
            else:
                base_x = (slot % tile_columns) * tile_size + 1
                base_y = (slot // tile_columns) * tile_size + 1
            first = {"x": base_x, "y": base_y, **first_size}
            second = (
                {"x": base_x + first_size["w"] + gap, "y": base_y, **second_size}
                if axis == "horizontal"
                else {"x": base_x, "y": base_y + first_size["h"] + gap, **second_size}
            )
            first_group.append(first)
            second_group.append(second)
        if request.mergeKind == "pair":
            prompt = _render_prompt_template(
                request.promptTemplate,
                {
                    "droplet1": _prompt_rect(first_group[0]),
                    "droplet2": _prompt_rect(second_group[0]),
                },
                ["droplet1", "droplet2"],
            )
        else:
            group_text = lambda group: "；".join(
                f"{index + 1}. {_prompt_rect(rect)}" for index, rect in enumerate(group)
            )
            prompt = _render_prompt_template(
                request.promptTemplate,
                {
                    "count": str(pair_count),
                    "group1": group_text(first_group),
                    "group2": group_text(second_group),
                },
                ["count", "group1", "group2"],
            )
        parameters = (
            f"液滴组1={'/'.join(_rect_text(rect) for rect in first_group)}；"
            f"液滴组2={'/'.join(_rect_text(rect) for rect in second_group)}"
        )
        experiments.append(
            {
                "category": request.category,
                "mode": "complete",
                "repeats": request.repeats,
                "notes": (
                    f"{request.notes} 可复现种子={request.seed}；"
                    f"尺寸={request.sizeMin}x{request.sizeMin} 至 "
                    f"{request.sizeMax}x{request.sizeMax}；液滴对数={pair_count}"
                ).strip(),
                "steps": [
                    {
                        "prompt": prompt,
                        "expectedOperation": "合并",
                        "expectedParameters": parameters,
                        "notes": "",
                    }
                ],
            }
        )
    return experiments


def usage_from_message(message: Any) -> Dict[str, Any]:
    usage = getattr(message, "usage_metadata", None) or {}
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or input_tokens + output_tokens)
    return {
        "available": bool(usage),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
    }


def response_text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                parts.append(str(block.get("text") or ""))
        return "".join(parts).strip()
    return str(content or "").strip()


def parse_json_object(text: str) -> Dict[str, Any]:
    value = str(text or "").strip()
    if value.startswith("```") and value.endswith("```"):
        first_newline = value.find("\n")
        value = value[first_newline + 1 : -3].strip() if first_newline >= 0 else ""
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        start = value.find("{")
        if start < 0:
            raise ValueError("Model response did not contain a JSON object.") from None
        try:
            parsed, _ = json.JSONDecoder().raw_decode(value[start:])
        except json.JSONDecodeError as error:
            raise ValueError(f"Model response contained invalid JSON: {error.msg}.") from None
    if not isinstance(parsed, dict):
        raise ValueError("Model response must be one JSON object.")
    return parsed


def materialize_designer_response(raw: Dict[str, Any]) -> Dict[str, Any]:
    parsed = (
        DesignerResponse.model_validate(raw)
        if hasattr(DesignerResponse, "model_validate")
        else DesignerResponse.parse_obj(raw)
    )
    data = parsed.model_dump() if hasattr(parsed, "model_dump") else parsed.dict()
    series = data.pop("mergeSeries", [])
    direct_experiments = data.pop("project", None)
    project_name = str(data.pop("projectName", "") or "").strip()
    if series:
        if direct_experiments:
            raise ValueError("Return either a direct project or compact merge series, not both.")
        if not project_name:
            raise ValueError("Compact merge series require a project name.")
        experiments: List[Dict[str, Any]] = []
        for request in series:
            parsed_request = (
                MergeSeriesRequest.model_validate(request)
                if hasattr(MergeSeriesRequest, "model_validate")
                else MergeSeriesRequest.parse_obj(request)
            )
            experiments.extend(build_merge_series(parsed_request))
        data["project"] = {
            "projectName": project_name,
            "experiments": experiments,
        }
    elif direct_experiments:
        if not project_name:
            raise ValueError("A direct project requires a project name.")
        data["project"] = {
            "projectName": project_name,
            "experiments": direct_experiments,
        }
    else:
        data["project"] = None
    project = data.get("project")
    if project:
        validate_project_structure(
            project,
            data.get("requestedExperimentCount"),
            data.get("requestedTotalRuns"),
            data.get("requestedCategoryCounts"),
        )
    data.pop("requestedExperimentCount", None)
    data.pop("requestedTotalRuns", None)
    data.pop("requestedCategoryCounts", None)
    return data


def main() -> None:
    payload = json.load(sys.stdin)
    skill = str(payload.get("skill") or "").strip()
    messages = payload.get("messages") or []
    current_draft = payload.get("currentDraft")
    grid_rows = int((current_draft or {}).get("gridRows") or 120)
    grid_cols = int((current_draft or {}).get("gridCols") or 140)
    model = ChatOpenAI(
        model=os.environ.get("OPENAI_MODEL", ""),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
        base_url=os.environ.get("OPENAI_BASE_URL", ""),
        timeout=600,
        max_retries=0,
        max_tokens=8192,
        **runtime_model_options(),
    )
    schema = (
        DesignerResponse.model_json_schema()
        if hasattr(DesignerResponse, "model_json_schema")
        else DesignerResponse.schema()
    )
    prompt_messages: List[Any] = [
        SystemMessage(
            content=(
                skill
                + "\n\nReturn exactly one JSON object and no Markdown or surrounding text. "
                "The object must satisfy this JSON Schema:\n"
                + json.dumps(schema, ensure_ascii=False)
            )
        ),
        SystemMessage(
            content=(
                f"The active grid has {grid_rows} rows and {grid_cols} columns. "
                f"Coordinates must satisfy 0 <= x, x + w <= {grid_cols}, "
                f"0 <= y, and y + h <= {grid_rows}. Check every explicit "
                "droplet, squeeze source, and generated array extent before returning JSON."
            )
        ),
    ]
    if current_draft:
        prompt_messages.append(
            SystemMessage(
                content="Current application draft JSON:\n"
                + json.dumps(current_draft, ensure_ascii=False)
            )
        )
    for item in messages[-20:]:
        role = item.get("role") if isinstance(item, dict) else ""
        content = str(item.get("content") or "").strip() if isinstance(item, dict) else ""
        if not content:
            continue
        prompt_messages.append(
            HumanMessage(content=content) if role == "user" else AIMessage(content=content)
        )
    total_usage = {"available": False, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    data: Dict[str, Any] = {}
    for attempt in range(3):
        response = model.invoke(prompt_messages)
        usage = usage_from_message(response)
        total_usage["available"] = total_usage["available"] or usage["available"]
        total_usage["inputTokens"] += usage["inputTokens"]
        total_usage["outputTokens"] += usage["outputTokens"]
        total_usage["totalTokens"] += usage["totalTokens"]
        content = response_text(response)
        try:
            data = materialize_designer_response(parse_json_object(content))
            break
        except ValueError as error:
            if attempt == 2:
                raise
            prompt_messages.extend(
                [
                    AIMessage(content=content),
                    HumanMessage(
                        content=(
                            "The JSON was rejected by schema or consistency validation. "
                            "Return the complete corrected JSON object only. "
                            f"Validation error: {str(error)[:2000]}"
                        )
                    ),
                ]
            )
    else:
        raise RuntimeError("LLM did not submit a valid experiment design after 3 attempts.")
    data["tokenUsage"] = total_usage
    print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
