# -*- coding: utf-8 -*-
"""全局配置。所有密钥只从环境变量读取，绝不进入前端。"""

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

WEB_DIR = ROOT / "web"
METHODS_FILE = ROOT / "methods" / "answer-frameworks.md"
DATA_DIR = ROOT / "data" / "sessions"
DATA_DIR.mkdir(parents=True, exist_ok=True)
COACH_DIR = ROOT / "data" / "coaching"
COACH_DIR.mkdir(parents=True, exist_ok=True)


def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


class Settings:
    # 语音脑：豆包 Seeduplex
    volc_api_key = _env("VOLC_API_KEY")
    volc_url = _env(
        "VOLC_REALTIME_URL",
        "wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue",
    )
    volc_model = _env("VOLC_MODEL", "1.2.6.1")
    volc_voice = _env("VOLC_VOICE", "zh_male_m191_uranus_bigtts")

    # 分析脑：OpenAI 兼容文本模型
    brain_api_key = _env("BRAIN_API_KEY")
    brain_base_url = _env("BRAIN_BASE_URL", "https://api.deepseek.com")
    brain_model = _env("BRAIN_MODEL", "deepseek-chat")
    brain_report_model = _env("BRAIN_REPORT_MODEL") or brain_model

    host = _env("HOST", "127.0.0.1")
    port = int(_env("PORT", "8000") or 8000)

    @property
    def voice_ready(self) -> bool:
        return bool(self.volc_api_key)

    @property
    def brain_ready(self) -> bool:
        return bool(self.brain_api_key)


settings = Settings()
