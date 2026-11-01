# -*- coding: utf-8 -*-
"""FastAPI 服务：网页 + 简历解析 + 面试方案 + 实时语音代理 + 复盘报告。"""

from __future__ import annotations

import logging
from datetime import datetime
from io import BytesIO
from typing import Any, Dict, Optional

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import realtime, store
from .brain import brain, default_plan
from .config import WEB_DIR, settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)

app = FastAPI(title="面试陪练 · 大模型内容安全运营")
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    """开发期禁用静态资源缓存，避免浏览器拿着旧 app.js 报未定义函数。"""
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


class PrepareRequest(BaseModel):
    role: str = "大模型内容安全运营"
    level: str = "3-5 年"
    company: str = ""
    jd: str = ""
    resume: str = ""


class ReportRequest(BaseModel):
    duration_sec: int = Field(default=0, ge=0)
    # 前端本地字幕作为兜底：万一服务端事件字段变化导致抓不到逐字稿
    transcript: list[dict] = Field(default_factory=list)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {
        "voice_ready": settings.voice_ready,
        "brain_ready": settings.brain_ready,
        "brain_model": settings.brain_model,
        "voice": settings.volc_voice,
    }


@app.post("/api/extract")
async def extract_resume(file: UploadFile = File(...)) -> Dict[str, str]:
    """从 txt / md / pdf 中抽取简历文本。"""
    raw = await file.read()
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="文件超过 8MB")

    name = (file.filename or "").lower()
    if name.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise HTTPException(status_code=500, detail="缺少 pypdf，请先 pip install -r requirements.txt") from exc
        reader = PdfReader(BytesIO(raw))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("gbk", errors="ignore")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="没有解析出文字，可能是扫描版 PDF")
    return {"text": text[:20000]}


@app.post("/api/prepare")
async def prepare(req: PrepareRequest) -> JSONResponse:
    role = (req.role or "大模型内容安全运营").strip()
    level = (req.level or "").strip()
    company = (req.company or "").strip()
    jd = (req.jd or "").strip()
    resume = (req.resume or "").strip()

    plan: Dict[str, Any]
    warning: Optional[str] = None

    if brain.ready and (jd or resume):
        try:
            plan = await brain.build_plan(role, level, company, jd, resume)
        except Exception as exc:
            logging.exception("build plan failed")
            plan = default_plan(role, level)
            warning = f"分析脑调用失败，已退回通用方案：{exc}"
    else:
        plan = default_plan(role, level)
        if not brain.ready:
            warning = "未配置 BRAIN_API_KEY，本次使用通用方案，复盘报告也不会生成。"
        else:
            warning = "没有提供 JD 或简历，本次使用通用方案。"

    session = store.create_session(
        role=role, level=level, company=company, jd=jd, resume=resume, plan=plan
    )
    return JSONResponse(
        {
            "session_id": session["id"],
            "plan": plan,
            "brain_ready": brain.ready,
            "voice_ready": settings.voice_ready,
            "warning": warning,
        }
    )


@app.get("/api/session/{sid}")
async def get_session(sid: str) -> JSONResponse:
    session = store.get_session(sid)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return JSONResponse(session)


@app.post("/api/session/{sid}/report")
async def build_report(sid: str, req: ReportRequest) -> JSONResponse:
    session = store.get_session(sid)
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    if req.duration_sec:
        session["duration_sec"] = req.duration_sec
    session["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")

    if not session["transcript"] and req.transcript:
        for item in req.transcript:
            role = item.get("role") if isinstance(item, dict) else ""
            text = item.get("text") if isinstance(item, dict) else ""
            if role in {"candidate", "interviewer"} and isinstance(text, str):
                store.append_turn(session, role, text)

    store.save_session(session)

    transcript = store.transcript_text(session)
    if not transcript.strip():
        raise HTTPException(status_code=400, detail="还没有对话记录")

    if not brain.ready:
        return JSONResponse(
            {
                "warning": "未配置 BRAIN_API_KEY，无法生成深度报告。配置后重新发起一场即可。",
                "transcript": session["transcript"],
            }
        )

    try:
        report = await brain.build_report(
            session["plan"],
            transcript,
            jd=session.get("jd", ""),
            resume=session.get("resume", ""),
        )
    except Exception as exc:
        logging.exception("build report failed")
        raise HTTPException(status_code=502, detail=f"生成报告失败：{exc}") from exc

    session["report"] = report
    store.save_session(session)
    return JSONResponse({"report": report, "transcript": session["transcript"]})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    sid = ws.query_params.get("sid", "")
    await ws.accept()
    await realtime.proxy(ws, sid)


if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)
