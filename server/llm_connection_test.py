from __future__ import annotations

import json
import os
import sys
import time

from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL


@tool("connection_probe")
def connection_probe(value: str) -> str:
    """Return the supplied value to verify structured tool-call support."""
    return value


def runtime_model_options() -> dict:
    thinking_mode = os.getenv("OPENAI_THINKING_MODE", "").strip()
    if thinking_mode in {"enabled", "disabled"}:
        return {"extra_body": {"thinking": {"type": thinking_mode}}}
    return {}


def tool_binding_options() -> dict:
    if os.getenv("OPENAI_THINKING_MODE", "").strip() == "enabled":
        return {}
    return {"tool_choice": "required"}


def main() -> None:
    model_name = os.getenv("OPENAI_MODEL", LLM_MODEL)
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        timeout=20,
        max_retries=0,
        max_tokens=256,
        **runtime_model_options(),
    )
    started_at = time.monotonic()
    response = llm.bind_tools(
        [connection_probe],
        **tool_binding_options(),
    ).invoke("Call connection_probe once with the value OK.")
    calls = getattr(response, "tool_calls", None) or []
    if not calls or calls[0].get("name") != "connection_probe":
        raise RuntimeError(
            "The endpoint can generate text but did not return the required tool call. "
            "This model or API gateway is not compatible with DMF execution."
        )
    latency_ms = round((time.monotonic() - started_at) * 1000)
    print(json.dumps({"ok": True, "model": model_name, "latencyMs": latency_ms, "toolCalls": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(str(error))
        raise SystemExit(1) from None
