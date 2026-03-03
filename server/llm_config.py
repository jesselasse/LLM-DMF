import os

# Centralized LLM configuration (override via env if needed).
LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.univibe.cc/openai/v1")
LLM_API_KEY = os.getenv("OPENAI_API_KEY", "sk-GhQYMlcSE0yc5XU2mIESKrblq5S8Repy")
LLM_MODEL = "gpt-5.3-codex"  # Default model for LLM interactions

# LLM_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
# LLM_API_KEY = os.getenv("OPENAI_API_KEY", "sk-9f067b7023bc4ef6bb3d97772175df72")
# LLM_BASE_URL = "https://integrate.api.nvidia.com/v1"
# LLM_API_KEY = "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"
