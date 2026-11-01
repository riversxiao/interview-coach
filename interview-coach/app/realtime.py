# -*- coding: utf-8 -*-
"""语音脑接入层：把浏览器和豆包 Seeduplex 全双工实时语音连起来。

浏览器不能自定义 WebSocket 请求头，所以必须由后端代理并注入 X-Api-Key。
密钥永远不出现在前端。

协议要点（来自火山引擎官方文档）：
- 纯 JSON 文本帧，type 字段路由事件
- 上行音频：PCM / 16k / int16 / 小端，20ms 一包（640 字节），base64 放在 audio 字段
- 下行音频：response.output_audio.delta，base64 PCM
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Any, Dict, Optional

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import prompts, store
from .config import settings

log = logging.getLogger("interview.realtime")

# 提升内容安全领域术语的识别准确率
HOTWORDS = [
    "内容安全", "违规率", "漏放率", "误伤率", "召回率", "准确率",
    "badcase", "机审", "人审", "策略迭代", "抽样", "申诉", "舆情",
    "监管", "价值观对齐", "大模型安全", "红队", "越狱", "提示词注入",
    "分级处置", "灰度", "止损", "复盘",
]


def build_session_create(session: Dict[str, Any]) -> Dict[str, Any]:
    plan = session.get("plan") or {}
    instructions = prompts.build_interviewer_instructions(
        plan,
        role=session.get("role", ""),
        level=session.get("level", ""),
        company=session.get("company", ""),
    )
    return {
        "type": "session.create",
        "session": {
            "model": settings.volc_model,
            "instructions": instructions,
            "audio": {
                "input": {"format": {"type": "pcm", "rate": 16000}},
                "output": {
                    "format": {"type": "pcm_s16le", "rate": 24000},
                    "voice": settings.volc_voice,
                    "speed": 0,
                },
            },
            "extension": {
                "asr": {"context": {"hotwords": [{"word": w} for w in HOTWORDS]}},
                # 面试会讨论违规内容、监管等敏感话题，普通审核容易误拒
                "dialog": {"strict_audit": False},
            },
        },
    }


def _rms(b64: Optional[str]) -> int:
    """粗略估计上行音量，用于排查「麦克风送出的是静音」。"""
    if not b64:
        return 0
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return 0
    if len(raw) < 2:
        return 0
    total = 0
    for i in range(0, len(raw) - 1, 2):
        sample = int.from_bytes(raw[i:i + 2], "little", signed=True)
        total += abs(sample)
    return total // (len(raw) // 2)


def _str_field(evt: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = evt.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


class TranscriptTracker:
    """从下行事件里还原逐字稿。

    不同版本的事件字段略有差异，这里做容错：
    优先取 completed/done 事件里的完整文本，取不到就用 delta 累积。
    """

    def __init__(self, session: Dict[str, Any]) -> None:
        self.session = session
        self._user_buf = ""
        self._assistant_buf = ""

    def feed(self, evt: Dict[str, Any]) -> None:
        etype = evt.get("type", "")
        if etype == "conversation.item.input_audio_transcription.delta":
            # 注意：ASR 的 delta 是「累积文本」，不是增量片段
            self._user_buf = _str_field(evt, "delta", "text", "transcript")
        elif etype == "conversation.item.input_audio_transcription.completed":
            text = _str_field(evt, "transcript", "text") or self._user_buf
            self._user_buf = ""
            store.append_turn(self.session, "candidate", text)
        elif etype == "response.output_text.delta":
            self._assistant_buf += _str_field(evt, "delta", "text")
        elif etype == "response.output_text.done":
            text = _str_field(evt, "text", "transcript") or self._assistant_buf
            self._assistant_buf = ""
            store.append_turn(self.session, "interviewer", text)
        elif etype == "error":
            log.warning("downstream error: %s", json.dumps(evt, ensure_ascii=False)[:500])


async def _safe_send(ws: WebSocket, raw: str) -> bool:
    try:
        await ws.send_text(raw)
        return True
    except Exception:
        return False


async def proxy(ws: WebSocket, sid: str) -> None:
    session: Optional[Dict[str, Any]] = store.get_session(sid)
    if not session:
        await ws.close(code=4404, reason="session not found")
        return

    if not settings.volc_api_key:
        await ws.send_json(
            {"type": "local.error", "message": "未配置 VOLC_API_KEY，请先在 .env 中填写豆包语音 API Key。"}
        )
        await ws.close()
        return

    headers = {
        "X-Api-Key": settings.volc_api_key,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }

    try:
        upstream = await websockets.connect(
            settings.volc_url,
            additional_headers=headers,
            max_size=None,
            ping_interval=20,
            ping_timeout=20,
            close_timeout=5,
        )
    except Exception as exc:
        log.exception("connect upstream failed")
        await ws.send_json(
            {"type": "local.error", "message": f"连接豆包实时语音失败：{exc}"}
        )
        await ws.close()
        return

    log.info("upstream connected session=%s", sid)

    try:
        await upstream.send(
            json.dumps(build_session_create(session), ensure_ascii=False)
        )
        log.info("session.create sent session=%s", sid)
    except Exception as exc:
        log.exception("send session.create failed")
        await ws.send_json({"type": "local.error", "message": f"创建会话失败：{exc}"})
        await upstream.close()
        await ws.close()
        return

    tracker = TranscriptTracker(session)
    greeting_sent = False
    closed_by_client = False
    audio_frames = 0

    async def client_to_upstream() -> None:
        nonlocal closed_by_client, audio_frames
        while True:
            raw = await ws.receive_text()
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if evt.get("type") == "session.close":
                closed_by_client = True
            if evt.get("type") == "input_audio_buffer.append":
                audio_frames += 1
                if audio_frames % 100 == 0:
                    log.info("uplink audio frames=%d b64=%d rms=%d", audio_frames,
                             len(evt.get("audio") or ""), _rms(evt.get("audio")))
            await upstream.send(raw)

    async def upstream_to_client() -> None:
        nonlocal greeting_sent
        async for raw in upstream:
            await _safe_send(ws, raw)
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type", "")
            if not etype.endswith("audio.delta"):
                log.info("downlink %s", json.dumps(evt, ensure_ascii=False)[:240])
            if etype == "session.created" and not greeting_sent:
                greeting_sent = True
                opening = (session.get("plan") or {}).get("opening") or "你好，我们先从自我介绍开始吧。"
                await upstream.send(
                    json.dumps(
                        {"type": "speech_text_buffer.commit", "text": opening},
                        ensure_ascii=False,
                    )
                )
            elif etype == "session.created":
                log.info("session created: %s", evt.get("session", {}).get("id"))

            tracker.feed(evt)

            if etype in {"session.closed", "session.finished"}:
                store.save_session(session)
                break

    t1 = asyncio.create_task(client_to_upstream())
    t2 = asyncio.create_task(upstream_to_client())
    try:
        done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                log.warning("pump ended with %r", exc)
    finally:
        store.save_session(session)
        try:
            if not closed_by_client and upstream.state.name == "OPEN":
                await upstream.send(json.dumps({"type": "session.close"}))
                await asyncio.sleep(0.2)
        except Exception:
            pass
        await upstream.close()
        try:
            await ws.close()
        except Exception:
            pass
        log.info("proxy closed session=%s turns=%d", sid, len(session["transcript"]))
