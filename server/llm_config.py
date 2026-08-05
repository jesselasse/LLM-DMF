import os


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


LLM_BASE_URL = _require_env("OPENAI_BASE_URL")
LLM_API_KEY = _require_env("OPENAI_API_KEY")
LLM_MODEL = os.getenv("OPENAI_MODEL") or "gpt-5.4"
