# -*- coding: utf-8 -*-
"""会话存储：一次面试 = 一份 JSON，方便回看和后续做数据分析。"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import COACH_DIR, DATA_DIR


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _path(sid: str) -> Path:
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")
    return DATA_DIR / f"{safe}.json"


def create_session(
    *,
    role: str,
    level: str,
    company: str,
    jd: str,
    resume: str,
    plan: Dict[str, Any],
    materials: str = "",
) -> Dict[str, Any]:
    sid = uuid.uuid4().hex[:12]
    session = {
        "id": sid,
        "created_at": _now(),
        "finished_at": None,
        "role": role,
        "level": level,
        "company": company,
        "jd": jd,
        "resume": resume,
        "materials": materials,
        "plan": plan,
        "outlines": None,
        "transcript": [],
        "report": None,
        "duration_sec": 0,
    }
    save_session(session)
    return session


def save_session(session: Dict[str, Any]) -> None:
    _path(session["id"]).write_text(
        json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_session(sid: str) -> Optional[Dict[str, Any]]:
    path = _path(sid)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_sessions(limit: int = 20) -> List[Dict[str, Any]]:
    files = sorted(DATA_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    out: List[Dict[str, Any]] = []
    for f in files[:limit]:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append(
            {
                "id": data.get("id"),
                "created_at": data.get("created_at"),
                "role": data.get("role"),
                "company": data.get("company"),
                "score": (data.get("report") or {}).get("overall", {}).get("score"),
            }
        )
    return out


def append_turn(session: Dict[str, Any], role: str, text: str) -> Optional[Dict[str, Any]]:
    """追加一轮发言；相同角色连续说两段时合并，避免字幕碎成一地。"""
    text = (text or "").strip()
    if not text:
        return None
    last = session["transcript"][-1] if session["transcript"] else None
    if last and last["role"] == role:
        last["text"] = (last["text"] + " " + text).strip()
        return last
    item = {"role": role, "text": text, "at": _now()}
    session["transcript"].append(item)
    return item


def transcript_text(session: Dict[str, Any]) -> str:
    names = {"interviewer": "面试官", "candidate": "候选人", "coach": "教练"}
    return "\n".join(f"{names.get(t['role'], t['role'])}：{t['text']}" for t in session["transcript"])


# ---------------------------------------------------------------- 教练练习
# 每次教练练习单独存一个文件，避免和面试会话的 JSON 互相覆盖（两边可能同时在写）


def _safe(value: str) -> str:
    return "".join(c for c in value if c.isalnum() or c in "-_")


def _coach_dir(sid: str) -> Path:
    return COACH_DIR / _safe(sid)


def create_coaching(sid: str, data: Dict[str, Any]) -> Dict[str, Any]:
    record = {
        "id": uuid.uuid4().hex[:10],
        "session_id": sid,
        "created_at": _now(),
        "transcript": [],
        "summary": None,
        **data,
    }
    save_coaching(record)
    return record


def save_coaching(record: Dict[str, Any]) -> None:
    folder = _coach_dir(record["session_id"])
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{_safe(record['id'])}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_coaching(sid: str, cid: str) -> Optional[Dict[str, Any]]:
    path = _coach_dir(sid) / f"{_safe(cid)}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_coaching(sid: str) -> List[Dict[str, Any]]:
    folder = _coach_dir(sid)
    if not folder.exists():
        return []
    items = []
    for f in folder.glob("*.json"):
        try:
            items.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    return sorted(items, key=lambda r: r.get("created_at") or "")
