# -*- coding: utf-8 -*-
"""
Agent 运行时：整个产品的心脏。

一个任务 = 反复执行「LLM 决策 -> 代码执行 -> 结果回灌」，直到模型说干完了。

关键认知：LLM 是无状态的。它不记得任何东西，
所以每一轮都要把 messages 全量重新发给它。所谓「Agent 记得之前改了什么」，
全部来自你自己维护的这个 messages 列表。
"""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from openai import OpenAI

from tools import MAX_RESULT_CHARS, TOOL_REGISTRY, TOOL_SCHEMAS, WORKSPACE

# ---------------------------------------------------------------- 终端配色

C_RESET = "\033[0m"
C_DIM = "\033[2m"
C_CYAN = "\033[36m"
C_YELLOW = "\033[33m"
C_RED = "\033[31m"
C_GREEN = "\033[32m"
C_MAGENTA = "\033[35m"

_print_lock = threading.Lock()


def _log(text: str) -> None:
    with _print_lock:
        print(text, flush=True)


# ---------------------------------------------------------------- system prompt

# system prompt 里放的是「策略」，不是「接口文档」。
# 工具能做什么写在 schema 里；什么时候该用它、用错了怎么办，写在这里。
SYSTEM_PROMPT = """你是一个在受限工作区内工作的文件助手。

工作区根目录：{workspace}
你所有的路径参数都必须相对于这个根目录，不能访问工作区之外的文件。

工作规则：
1. 动手之前先观察。不确定结构时先 list_dir，不确定文件内容时先 read_file。
2. 修改文件前必须先读过它的原文，禁止凭空覆盖你不了解内容的文件。
3. 不要连续用完全相同的参数重复调用同一个工具；失败后要换策略。
4. 批量、重复、需要管道或精确计算的操作，用 bash 一次写完，不要拆成很多次调用。
5. 任务完成后，用一两句话说明你做了什么、动了哪些文件，然后直接结束，不要再调用工具。
"""


# ---------------------------------------------------------------- 小工具函数


def truncate(text: str, limit: int = MAX_RESULT_CHARS) -> str:
    """截断过长的工具结果，保留头尾，并明确告诉模型「中间被省略了」。"""
    if len(text) <= limit:
        return text
    half = limit // 2
    omitted = len(text) - limit
    return (
        text[:half]
        + f"\n... [内容过长，中间已省略 {omitted} 字符] ...\n"
        + text[-half:]
    )


def _digest(value: Any, limit: int = 500) -> str:
    """把任意值转成一行便于打印的摘要。"""
    s = str(value).replace("\n", "\n    ")
    return s[:limit] + (" ..." if len(s) > limit else "")


def _assistant_message(msg: Any) -> Dict[str, Any]:
    """
    把 SDK 返回的 assistant message 转成可以回传给 API 的原始结构。

    为什么必须「原样」存回去？
      - 模型下一轮需要看到自己刚才说了什么、调了什么工具，否则会重复劳动。
      - tool_calls 里的 id 必须保留，下一轮的 tool_result 靠它对号。
    """
    item: Dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
    tool_calls = getattr(msg, "tool_calls", None)
    if tool_calls:
        item["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in tool_calls
        ]
    return item


def _context_size(messages: List[Dict[str, Any]]) -> int:
    """粗略估算当前上下文占用的字符数（真实实现应按 token 精确计量）。"""
    total = 0
    for m in messages:
        total += len(str(m.get("content") or ""))
        for tc in m.get("tool_calls") or []:
            total += len(str(tc.get("function", {}).get("arguments") or ""))
    return total


# ---------------------------------------------------------------- 工具执行层


def _call_one_tool(tool_call: Any, seen: Dict[str, int]) -> Dict[str, Any]:
    """
    执行单个工具调用，任何异常都转成文本回灌给模型，绝不向上抛。

    这是 Agent 容错的核心：
      抛异常 = 整个 loop 挂掉
      回灌错误文本 = 模型自己看到错误、自己换策略
    前提是错误信息足够可读。
    """
    name = tool_call.function.name
    raw_args = tool_call.function.arguments or "{}"
    repeat_key = f"{name}:{raw_args}"

    # 重复调用检测：同一工具 + 同一参数超过 3 次，强制打断，避免死循环烧钱
    seen[repeat_key] = seen.get(repeat_key, 0) + 1
    if seen[repeat_key] > 3:
        out = (
            f"ERROR: 这已经是你第 {seen[repeat_key]} 次用完全相同的参数调用 {name}。"
            f"结果不会改变，请立即换一个策略。"
        )
        return _tool_result(tool_call.id, out, is_error=True, name=name, args=raw_args)

    try:
        args = json.loads(raw_args)
        if not isinstance(args, dict):
            raise ValueError("工具参数必须是一个 JSON 对象")

        if name not in TOOL_REGISTRY:
            raise KeyError(
                f"工具 '{name}' 不存在。当前可用工具：{', '.join(TOOL_REGISTRY.keys())}"
            )

        out = TOOL_REGISTRY[name](**args)
        return _tool_result(tool_call.id, str(out), is_error=False, name=name, args=raw_args)

    except json.JSONDecodeError as e:
        return _tool_result(
            tool_call.id,
            f"ERROR: 参数不是合法 JSON（{e}）。请重新生成一个合法的 JSON 对象作为参数。",
            is_error=True,
            name=name,
            args=raw_args,
        )
    except TypeError as e:
        # 常见原因：模型编了一个 schema 里没有的参数名
        return _tool_result(
            tool_call.id,
            f"ERROR: 参数不匹配（{e}）。请严格按工具 schema 里的参数名和类型传参。",
            is_error=True,
            name=name,
            args=raw_args,
        )
    except Exception as e:
        return _tool_result(
            tool_call.id,
            f"ERROR: {type(e).__name__}: {e}",
            is_error=True,
            name=name,
            args=raw_args,
        )


def _tool_result(
    tool_call_id: str, content: str, is_error: bool, name: str, args: str
) -> Dict[str, Any]:
    """组装一条回灌给模型的 tool 消息，同时把过程打印到终端。"""
    content = truncate(content)
    if is_error:
        _log(f"{C_RED}[tool] {name}({_digest(args, 120)}){C_RESET}")
        _log(f"{C_RED}  ! {_digest(content, 400)}{C_RESET}")
    else:
        _log(f"{C_CYAN}[tool] {name}({_digest(args, 120)}){C_RESET}")
        _log(f"{C_DIM}  {_digest(content, 400)}{C_RESET}")

    # 注意：OpenAI 协议里工具结果用 role="tool" + tool_call_id；
    # Anthropic 协议里则是 role="user" + tool_result block。语义上是一回事。
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}


def _execute_tool_calls(
    tool_calls: List[Any], seen: Dict[str, int]
) -> List[Dict[str, Any]]:
    """
    并发执行同一轮里的多个工具调用。

    模型一次可以返回多个 tool_call（比如同时读三个文件）。
    串行执行纯属浪费，用线程池并发。
    有依赖的调用（先读后写）模型自己会分批，不需要我们判断。
    """
    if len(tool_calls) == 1:
        return [_call_one_tool(tool_calls[0], seen)]

    with ThreadPoolExecutor(max_workers=len(tool_calls)) as pool:
        return list(pool.map(lambda tc: _call_one_tool(tc, seen), tool_calls))


# ---------------------------------------------------------------- 主循环


def build_client() -> OpenAI:
    """构造一个 OpenAI 兼容客户端。国内模型基本都是这套协议。"""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit(
            "缺少 OPENAI_API_KEY。\n"
            "请先复制 .env.example 为 .env 并填入自己的密钥，例如：\n"
            "  cp .env.example .env"
        )
    base_url = os.getenv("OPENAI_BASE_URL") or None
    return OpenAI(api_key=api_key, base_url=base_url)


def run_agent(
    task: str,
    client: Optional[OpenAI] = None,
    model: Optional[str] = None,
    max_turns: int = 25,
    verbose: bool = True,
) -> str:
    """跑完一个任务，返回最终的自然语言结论。"""
    client = client or build_client()
    model = model or os.getenv("MODEL", "deepseek-chat")

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT.format(workspace=WORKSPACE)},
        {"role": "user", "content": task},
    ]
    seen: Dict[str, int] = {}

    for turn in range(1, max_turns + 1):
        if verbose:
            _log(
                f"\n{C_MAGENTA}━━━━ turn {turn}/{max_turns}"
                f"  消息数={len(messages)}  上下文≈{_context_size(messages)} 字符"
                f" ━━━━{C_RESET}"
            )

        # ---------- ① LLM 调用：决策 ----------
        # messages 全量重发；tools 每次都要带（这部分是纯 token 开销，真实产品必须开 prompt cache）
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOL_SCHEMAS,
        )
        choice = resp.choices[0]
        msg = choice.message
        finish_reason = choice.finish_reason

        # ---------- ② 把 assistant 的原始输出存回历史 ----------
        messages.append(_assistant_message(msg))

        if verbose and (msg.content or "").strip():
            _log(f"{C_GREEN}[assistant] {_digest(msg.content.strip(), 600)}{C_RESET}")

        # ---------- ③ 输出被长度限制截断 ----------
        # 这是最阴的一个坑：如果截断发生在 tool_calls 的 arguments 里，
        # 参数就是残缺 JSON。而且必须给每个 tool_call 补一条 tool 消息，
        # 否则下一轮 API 会报「assistant 的 tool_calls 没有对应的 tool 结果」。
        if finish_reason == "length":
            if verbose:
                _log(f"{C_YELLOW}[warn] 输出被 max_tokens 截断，要求模型拆小重试{C_RESET}")
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": (
                                "ERROR: 你的工具调用参数被长度限制截断了，本次未执行。"
                                "请把内容拆小（比如分多次 write_file，或减少单次写入长度）后重试。"
                            ),
                        }
                    )
            else:
                messages.append(
                    {
                        "role": "user",
                        "content": "你上一条输出被长度限制截断了，请继续，或者拆成更小的步骤。",
                    }
                )
            continue

        # ---------- ④ 终止条件：模型不再调用工具 ----------
        if not msg.tool_calls:
            return (msg.content or "").strip()

        # ---------- ⑤ 确定性执行，然后进入下一圈 ----------
        messages.extend(_execute_tool_calls(msg.tool_calls, seen))

    return (
        f"任务未在 {max_turns} 轮内完成，已强制停止（防止无限烧 token）。\n"
        f"最后一轮上下文约 {_context_size(messages)} 字符。"
    )
