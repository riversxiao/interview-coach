# -*- coding: utf-8 -*-
"""答题方法论：读写 methods/answer-frameworks.md，并解析出结构化的框架列表。

文件是唯一数据源，每次请求都重新读取，改完文件不需要重启服务。
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from .config import METHODS_FILE

GENERAL_SECTIONS = {"通用原则", "记忆方法"}
QUESTION_TYPES = {"self_intro", "resume", "case", "scenario", "behavior"}
MAX_BYTES = 200_000

_FIELD_RE = re.compile(r"^-\s*([^：:]{1,12})[：:]\s*(.+)$")


def read_text() -> str:
    if not METHODS_FILE.exists():
        return ""
    return METHODS_FILE.read_text(encoding="utf-8")


def write_text(text: str) -> Dict[str, Any]:
    """保存前先解析校验，至少要有一个带骨架的框架，避免把文件存坏。"""
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise ValueError("文件过大（上限 200KB）")
    parsed = parse(text)
    if not parsed["frameworks"]:
        raise ValueError("没有解析出任何答题框架：每个框架需要一个「## 名称」标题和一行「- 骨架：A → B → C」")
    METHODS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = METHODS_FILE.with_suffix(".md.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(METHODS_FILE)
    return parsed


def parse(text: str) -> Dict[str, Any]:
    sections: List[Dict[str, Any]] = []
    current: Dict[str, Any] | None = None
    for line in text.splitlines():
        if line.startswith("## "):
            current = {"name": line[3:].strip(), "lines": []}
            sections.append(current)
        elif current is not None:
            current["lines"].append(line)

    general: Dict[str, str] = {}
    frameworks: List[Dict[str, Any]] = []
    for sec in sections:
        body = "\n".join(sec["lines"]).strip()
        if sec["name"] in GENERAL_SECTIONS:
            general[sec["name"]] = body
            continue

        fields: Dict[str, str] = {}
        for line in sec["lines"]:
            m = _FIELD_RE.match(line.strip())
            if m:
                fields[m.group(1).strip()] = m.group(2).strip()

        steps = [s.strip() for s in re.split(r"→|->", fields.get("骨架", "")) if s.strip()]
        if not steps:
            continue
        types = [
            t.strip()
            for t in re.split(r"[,，、\s]+", fields.get("适用题型", ""))
            if t.strip() in QUESTION_TYPES
        ]
        frameworks.append(
            {
                "name": sec["name"],
                "types": types,
                "steps": steps,
                "mnemonic": fields.get("口诀", ""),
                "opening": fields.get("开场句", ""),
                "duration": fields.get("时长", ""),
                "pitfalls": fields.get("常见错误", ""),
                "fields": fields,
                "body": body,
            }
        )
    return {"general": general, "frameworks": frameworks}


def load() -> Dict[str, Any]:
    return parse(read_text())


def pick_for_type(frameworks: List[Dict[str, Any]], qtype: str) -> Dict[str, Any] | None:
    for fw in frameworks:
        if qtype in fw["types"]:
            return fw
    return frameworks[0] if frameworks else None


def prompt_text(parsed: Dict[str, Any]) -> str:
    """给分析模型看的方法论摘要。"""
    parts = []
    for name, body in parsed["general"].items():
        parts.append(f"【{name}】\n{body}")
    for fw in parsed["frameworks"]:
        parts.append(f"【框架：{fw['name']}】\n{fw['body']}")
    return "\n\n".join(parts)
