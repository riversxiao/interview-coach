# -*- coding: utf-8 -*-
"""分析脑：负责读简历出题，以及基于逐字稿生成深度反馈。

为什么不用语音模型直接做这些？
  实时语音模型优先保证低延迟和口语自然度，长链路推理和严格的结构化输出不是它的强项。
  把「说」和「想」拆开，才能既像真人对话，又给出有证据、可执行的反馈。
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from . import methods, prompts
from .config import settings

DEFAULT_QUESTIONS: List[Dict[str, Any]] = [
    {
        "id": 1,
        "type": "self_intro",
        "question": "先做个自我介绍吧，重点讲你最近一段和内容安全相关的经历。",
        "intent": "确认经历真实性和表达结构",
        "expected_points": ["职责边界清晰", "有具体项目和结果"],
        "followups": ["这段经历里，哪部分是你独立负责的？"],
    },
    {
        "id": 2,
        "type": "case",
        "question": "挑一个你印象最深的 badcase，从发现到复盘完整讲一遍。",
        "intent": "验证案例深度与归因能力",
        "expected_points": ["现象与影响面", "归因过程", "处置动作", "复盘后的机制变化"],
        "followups": ["当时怎么判断是策略问题还是模型问题？"],
    },
    {
        "id": 3,
        "type": "resume",
        "question": "你们的漏放率和误伤率是怎么定义的？这两个指标冲突时你怎么取舍？",
        "intent": "验证指标意识与业务判断",
        "expected_points": ["口径定义", "取样的局限性", "取舍依据"],
        "followups": ["如果业务方只盯着误伤，你怎么回应？"],
    },
    {
        "id": 4,
        "type": "case",
        "question": "一条新策略上线后，你怎么证明它真的有效，而不是碰上了大盘波动？",
        "intent": "验证实验设计与数据严谨性",
        "expected_points": ["对照组或灰度", "核心指标", "观察周期", "排除干扰因素"],
        "followups": ["灰度期间出现过指标反弹吗？怎么处理的？"],
    },
    {
        "id": 5,
        "type": "scenario",
        "question": "假设一个热点事件让违规内容量涨了五倍，人审产能完全跟不上，你接下来两个小时怎么安排？",
        "intent": "验证应急判断与资源调度",
        "expected_points": ["先止损再精细", "分级处置", "升级与跨团队协同", "对外口径"],
        "followups": ["如果这时监管来问进展，你怎么汇报？"],
    },
    {
        "id": 6,
        "type": "scenario",
        "question": "业务方觉得你的标准太严，影响增长，要求放宽，你怎么处理？",
        "intent": "验证原则性与沟通能力",
        "expected_points": ["风险量化", "分层放行", "责任边界", "用数据对齐"],
        "followups": ["如果对方是比你高两级的负责人呢？"],
    },
    {
        "id": 7,
        "type": "behavior",
        "question": "为什么想做内容安全运营？未来一年你想在这个岗位上做成什么？",
        "intent": "验证动机稳定性与成长预期",
        "expected_points": ["真实动机", "对岗位压力的认知", "可落地的目标"],
        "followups": ["这份工作里最消耗人的部分，你怎么看？"],
    },
]


def default_plan(role: str, level: str) -> Dict[str, Any]:
    """没有配置分析脑时的兜底方案，保证语音面试仍然可用。"""
    return {
        "candidate_profile": {
            "summary": f"未配置分析脑，无法解析简历。当前按「{role}」通用要求进行面试。",
            "strengths": [],
            "risks": ["简历未解析，问题可能不够贴合个人经历"],
            "probe_points": ["重点确认候选人的真实职责边界与量化结果"],
        },
        "focus_areas": ["案例深度", "数据意识", "应急协同", "岗位动机"],
        "opening": "你好，我是今天这场面试的面试官。先从自我介绍开始吧，重点讲讲你最近一段和内容安全相关的经历。",
        "questions": DEFAULT_QUESTIONS,
        "closing": "今天先到这里，感谢你的时间，后续有结果我们会同步给你。",
        "brain_enabled": False,
    }


class BrainUnavailable(RuntimeError):
    pass


class Brain:
    def __init__(self) -> None:
        self._client: Optional[AsyncOpenAI] = None
        if settings.brain_ready:
            self._client = AsyncOpenAI(
                api_key=settings.brain_api_key,
                base_url=settings.brain_base_url or None,
                timeout=180,
                max_retries=1,
            )

    @property
    def ready(self) -> bool:
        return self._client is not None

    async def _json(self, system: str, user: str, model: str) -> Dict[str, Any]:
        if not self._client:
            raise BrainUnavailable("未配置 BRAIN_API_KEY")

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        try:
            resp = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.4,
                response_format={"type": "json_object"},
            )
        except Exception:
            # 少数模型/网关不支持 response_format，退化为普通调用后自行解析
            resp = await self._client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.4,
            )

        text = (resp.choices[0].message.content or "").strip()
        return _loads_json(text)

    async def build_plan(
        self, role: str, level: str, company: str, jd: str, resume: str, materials: str = ""
    ) -> Dict[str, Any]:
        plan = await self._json(
            prompts.PLAN_SYSTEM,
            prompts.build_plan_user(role, level, company, jd, resume, materials),
            settings.brain_model,
        )
        plan.setdefault("opening", "你好，我是今天的面试官。先做个自我介绍吧。")
        plan.setdefault("questions", DEFAULT_QUESTIONS)
        plan.setdefault("focus_areas", [])
        plan.setdefault("candidate_profile", {})
        plan["brain_enabled"] = True
        return plan

    async def build_outlines(
        self,
        plan: Dict[str, Any],
        resume: str = "",
        materials: str = "",
        jd: str = "",
    ) -> List[Dict[str, Any]]:
        parsed = methods.load()
        data = await self._json(
            prompts.OUTLINE_SYSTEM,
            prompts.build_outline_user(methods.prompt_text(parsed), plan, resume, materials, jd),
            settings.brain_model,
        )
        return normalize_outlines(data.get("outlines") or [], plan, parsed["frameworks"])

    async def build_coach_brief(
        self,
        session: Dict[str, Any],
        question: str,
        answer: str,
        qid_hint: Any = None,
    ) -> Dict[str, Any]:
        plan = session.get("plan") or {}
        fallback = static_coach_brief(plan, qid_hint, answer)
        raw = await self._json(
            prompts.COACH_BRIEF_SYSTEM,
            prompts.build_coach_brief_user(
                methods.prompt_text(methods.load()),
                plan,
                (session.get("outlines") or {}).get("items") or [],
                session.get("resume", ""),
                session.get("materials", ""),
                question,
                answer,
                qid_hint,
            ),
            settings.brain_model,
        )
        return _normalize_brief(raw, fallback)

    async def build_coach_summary(
        self, record: Dict[str, Any], transcript_text: str, materials: str = ""
    ) -> Dict[str, Any]:
        raw = await self._json(
            prompts.COACH_SUMMARY_SYSTEM,
            prompts.build_coach_summary_user(record, transcript_text, materials),
            settings.brain_model,
        )
        return {
            "improved_answer": str(raw.get("improved_answer") or "").strip(),
            "takeaways": _str_list(raw.get("takeaways"), 4),
            "still_missing": _str_list(raw.get("still_missing"), 5),
            "progress": str(raw.get("progress") or "").strip(),
        }

    async def build_report(
        self,
        plan: Dict[str, Any],
        transcript_text: str,
        jd: str = "",
        resume: str = "",
        materials: str = "",
    ) -> Dict[str, Any]:
        report = await self._json(
            prompts.REPORT_SYSTEM,
            prompts.build_report_user(
                plan,
                transcript_text,
                jd=jd,
                resume=resume,
                materials=materials,
                methods_text=methods.prompt_text(methods.load()),
            ),
            settings.brain_report_model,
        )
        report["generated_by"] = settings.brain_report_model
        report["dimensions"] = _normalize_dimensions(report.get("dimensions") or [])
        return report


def _normalize_dimensions(raw: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """模型有时会自创维度 key，这里统一映射回评分标尺，并补上中文名。"""
    aliases = {
        "business": {"business", "strategy", "business_understanding"},
        "case": {"case", "risk_case", "risk", "case_depth"},
        "data": {"data", "metric", "metrics", "data_awareness"},
        "incident": {"incident", "emergency", "response", "incident_response"},
        "structure": {"structure", "expression", "communication", "structured_expression"},
        "fit": {"fit", "motivation", "matching", "role_fit"},
    }
    by_key: Dict[str, Dict[str, Any]] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        mapped = next((k for k, names in aliases.items() if key in names), key)
        by_key.setdefault(mapped, item)

    normalized: List[Dict[str, Any]] = []
    for rubric in prompts.RUBRIC:
        item = by_key.get(rubric["key"], {})
        score = item.get("score")
        try:
            score = round(float(score), 1) if score is not None else None
        except (TypeError, ValueError):
            score = None
        normalized.append(
            {
                "key": rubric["key"],
                "name": rubric["name"],
                "score": score,
                "comment": item.get("comment") or ("本轮未被覆盖，证据不足。" if score is None else ""),
                "evidence": item.get("evidence") or "",
            }
        )
    return normalized


def _str_list(value: Any, limit: int = 8) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


def static_outline(question: Dict[str, Any], framework: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """没有分析脑或模型漏题时的兜底：只给结构，不填素材。"""
    fw = framework or {"name": "", "steps": [], "mnemonic": "", "opening": ""}
    return {
        "id": question.get("id"),
        "framework": fw["name"],
        "why": "按题型匹配的默认框架",
        "material": "",
        "mnemonic": fw.get("mnemonic", ""),
        "opening_line": fw.get("opening", ""),
        "steps": [{"label": s, "points": ""} for s in fw.get("steps", [])],
        "keywords": [],
        "numbers": [],
        "short_version": "",
        "gaps": ["未生成个性化内容：请在每一步填上你自己的经历和数据"],
        "personalized": False,
    }


def normalize_outlines(
    raw: List[Dict[str, Any]],
    plan: Dict[str, Any],
    frameworks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """按问题顺序对齐模型输出；框架名对不上或缺题时，用题型默认框架兜底。"""
    by_name = {fw["name"]: fw for fw in frameworks}
    by_id: Dict[str, Dict[str, Any]] = {}
    for item in raw:
        if isinstance(item, dict) and item.get("id") is not None:
            by_id.setdefault(str(item["id"]), item)

    result: List[Dict[str, Any]] = []
    for q in plan.get("questions", []):
        default_fw = methods.pick_for_type(frameworks, q.get("type", ""))
        item = by_id.get(str(q.get("id")))
        if not item:
            result.append(static_outline(q, default_fw))
            continue

        fw = by_name.get(str(item.get("framework") or "").strip()) or default_fw
        steps = []
        for step in item.get("steps") or []:
            if isinstance(step, dict) and (step.get("label") or step.get("points")):
                steps.append(
                    {"label": str(step.get("label") or "").strip(), "points": str(step.get("points") or "").strip()}
                )
        if not steps and fw:
            steps = [{"label": s, "points": ""} for s in fw["steps"]]

        result.append(
            {
                "id": q.get("id"),
                "framework": fw["name"] if fw else str(item.get("framework") or ""),
                "why": str(item.get("why") or "").strip(),
                "material": str(item.get("material") or "").strip(),
                "mnemonic": str(item.get("mnemonic") or (fw or {}).get("mnemonic", "")).strip(),
                "opening_line": str(item.get("opening_line") or "").strip(),
                "steps": steps,
                "keywords": _str_list(item.get("keywords"), 6),
                "numbers": _str_list(item.get("numbers"), 6),
                "short_version": str(item.get("short_version") or "").strip(),
                "gaps": _str_list(item.get("gaps"), 6),
                "personalized": True,
            }
        )
    return result


def _find_question(plan: Dict[str, Any], qid: Any) -> Optional[Dict[str, Any]]:
    for q in plan.get("questions", []):
        if qid is not None and str(q.get("id")) == str(qid):
            return q
    return None


def static_coach_brief(plan: Dict[str, Any], qid: Any, answer: str) -> Dict[str, Any]:
    """没有分析脑时的备课单：按题型取框架，引导问题按骨架逐步问。"""
    frameworks = methods.load()["frameworks"]
    q = _find_question(plan, qid) or {}
    fw = methods.pick_for_type(frameworks, q.get("type", "")) or {"name": "STAR", "steps": [], "mnemonic": ""}
    has_answer = bool((answer or "").strip())
    return {
        "qid": q.get("id"),
        "framework": fw["name"],
        "mnemonic": fw.get("mnemonic", ""),
        "steps": [{"label": s, "status": "todo", "note": ""} for s in fw.get("steps", [])],
        "diagnosis": "",
        "strength": "",
        "guiding_questions": [f"「{s}」这一步，你会怎么讲？" for s in fw.get("steps", [])][:5],
        "hints": [
            "先想想面试官最想听到的结论是什么。",
            f"按「{fw.get('mnemonic') or fw['name']}」的顺序，看看漏了哪一步。",
            fw.get("opening") or "可以这样开头：结论是 XX，我讲一个 XX 的例子。",
        ],
        "target": "按结构讲完整，至少有一个数字和一个自己的判断",
        "opening": (
            "好，我们来练这题。你先说说，刚才自己觉得哪里没讲好？"
            if has_answer
            else "好，我们来练这题。你先用一两分钟试着答一遍，我听听。"
        ),
        "personalized": False,
    }


def _normalize_brief(raw: Dict[str, Any], fallback: Dict[str, Any]) -> Dict[str, Any]:
    steps = []
    for s in raw.get("steps") or []:
        if isinstance(s, dict) and s.get("label"):
            status = str(s.get("status") or "todo").strip()
            steps.append({
                "label": str(s["label"]).strip(),
                "status": status if status in {"ok", "weak", "missing", "todo"} else "todo",
                "note": str(s.get("note") or "").strip(),
            })
    names = {fw["name"] for fw in methods.load()["frameworks"]}
    framework = str(raw.get("framework") or "").strip()
    return {
        "qid": raw.get("qid") if raw.get("qid") is not None else fallback.get("qid"),
        "framework": framework if framework in names else fallback["framework"],
        "mnemonic": str(raw.get("mnemonic") or fallback.get("mnemonic") or "").strip(),
        "steps": steps or fallback["steps"],
        "diagnosis": str(raw.get("diagnosis") or "").strip(),
        "strength": str(raw.get("strength") or "").strip(),
        "guiding_questions": _str_list(raw.get("guiding_questions"), 6) or fallback["guiding_questions"],
        "hints": _str_list(raw.get("hints"), 3) or fallback["hints"],
        "target": str(raw.get("target") or fallback["target"]).strip(),
        "opening": str(raw.get("opening") or fallback["opening"]).strip(),
        "personalized": True,
    }


def static_outlines(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    frameworks = methods.load()["frameworks"]
    return [static_outline(q, methods.pick_for_type(frameworks, q.get("type", ""))) for q in plan.get("questions", [])]


def _loads_json(text: str) -> Dict[str, Any]:
    """模型偶尔会带 ```json 包裹或前后废话，这里做一次鲁棒解析。"""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise
        data = json.loads(cleaned[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    return data


brain = Brain()
