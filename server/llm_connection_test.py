from __future__ import annotations

import json
import os
import sys
import time

from langchain_openai import ChatOpenAI

from llm_config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL


def main() -> None:
    model_name = os.getenv("OPENAI_MODEL", LLM_MODEL)
    llm = ChatOpenAI(
        model=model_name,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        temperature=0,
        timeout=20,
        max_retries=0,
        max_tokens=1,
    )
    started_at = time.monotonic()
    llm.invoke("Reply with OK.")
    latency_ms = round((time.monotonic() - started_at) * 1000)
    print(json.dumps({"ok": True, "model": model_name, "latencyMs": latency_ms}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(str(error))
        raise SystemExit(1) from None
