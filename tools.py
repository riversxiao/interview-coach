# -*- coding: utf-8 -*-
"""
工具层。

每个工具由两部分组成：
  1. schema  —— 给模型看的说明书（名字 / 描述 / 参数字典）
  2. 实现    —— 真的去干活的 Python 函数

模型只会看到 schema，它永远不会直接执行你的代码。
它输出的是「工具名 + JSON 参数」，由 agent.py 里的确定性代码翻译成函数调用。
"""

import os
import subprocess
from pathlib import Path
from typing import Callable, Dict

# ---------------------------------------------------------------- 工作区沙箱

# 所有文件操作都被限制在这个目录内。
# 这是整个 demo 唯一的安全边界：模型再怎么幻觉，也出不了这个目录。
WORKSPACE = Path(os.getenv("WORKSPACE_DIR", "./workspace")).expanduser().resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

# 单条工具结果的长度上限。超过就截断，否则一次 cat 大文件就能把上下文撑爆。
MAX_RESULT_CHARS = 20000


def _safe_path(raw: str) -> Path:
    """把模型给的相对路径解析成绝对路径，并校验没有越出工作区。"""
    if not raw or not str(raw).strip():
        raw = "."
    target = (WORKSPACE / str(raw)).expanduser().resolve()
    try:
        target.relative_to(WORKSPACE)
    except ValueError:
        raise PermissionError(
            f"路径越界：'{raw}' 不在工作区内。所有路径都必须相对工作区根目录，"
            f"例如 'notes/today.md'。"
        )
    return target


# ---------------------------------------------------------------- 工具实现


def list_dir(path: str = ".") -> str:
    """列目录：模型在不了解结构时应该先调它。"""
    p = _safe_path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"'{path}' 不存在。建议先调用 list_dir(path='.') 查看工作区根目录有什么。"
        )
    if not p.is_dir():
        raise NotADirectoryError(f"'{path}' 是一个文件而不是目录，请改用 read_file 读取它。")

    entries = sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
    if not entries:
        return f"'{path}' 是空目录。"

    lines = []
    for e in entries:
        rel = e.relative_to(WORKSPACE)
        if e.is_dir():
            lines.append(f"[DIR ] {rel}/")
        else:
            lines.append(f"[FILE] {rel}\t{e.stat().st_size} B")
    return f"'{path}' 下共 {len(entries)} 项：\n" + "\n".join(lines)


def read_file(path: str, start_line: int = 1, end_line: int = 0) -> str:
    """读文件，返回带行号的内容。end_line=0 表示读到末尾。"""
    p = _safe_path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"文件 '{path}' 不存在。建议先 list_dir 确认文件名。"
        )
    if p.is_dir():
        raise IsADirectoryError(f"'{path}' 是目录，请改用 list_dir 查看它。")

    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines() or [""]
    total = len(lines)

    s = max(1, int(start_line or 1))
    e = total if not end_line else min(int(end_line), total)
    if s > total:
        return f"'{path}' 只有 {total} 行，你请求从第 {s} 行开始，已超出文件末尾。"

    body = "\n".join(f"{s + i:>5}| {line}" for i, line in enumerate(lines[s - 1:e]))
    tail = ""
    if e < total:
        tail = f"\n... 还有 {total - e} 行未显示，可用 start_line={e + 1} 继续读。"
    return f"'{path}' 共 {total} 行，以下是第 {s}-{e} 行：\n{body}{tail}"


def write_file(path: str, content: str) -> str:
    """写入（或覆盖）文件，父目录不存在会自动创建。"""
    p = _safe_path(path)
    existed = p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    rel = p.relative_to(WORKSPACE)
    action = "覆盖" if existed else "创建"
    return f"已{action} '{rel}'：{len(content)} 字符 / {content.count(chr(10)) + 1} 行。"


def bash(command: str, timeout: int = 30) -> str:
    """
    执行 shell 命令，cwd 固定在工作区。

    这个工具就是「让模型自己写脚本」的入口（见前面讨论的 L2 能力）。
    批量改名、批量替换这类任务，模型写一行脚本就能替代几十次工具调用。

    !! 安全提醒 !!
    shell=True 意味着模型在这里几乎拥有工作区内的任意权限。
    本地学习 demo 够用；要做给别人用的产品，必须换成容器沙箱 + 命令白名单 + 人工审批。
    """
    try:
        proc = subprocess.run(
            command,
            shell=True,
            executable="/bin/bash",
            cwd=str(WORKSPACE),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise TimeoutError(
            f"命令执行超过 {timeout} 秒被中止。请缩小批量范围或加更精确的过滤条件。"
        )

    parts = []
    if proc.stdout.strip():
        parts.append(proc.stdout.rstrip())
    if proc.stderr.strip():
        parts.append(f"[stderr]\n{proc.stderr.rstrip()}")
    parts.append(f"[exit code] {proc.returncode}")
    return "\n".join(parts)


# ---------------------------------------------------------------- 注册表

# 名字 -> 实现。agent.py 靠它把模型输出的 tool_call 翻译成真正的函数调用。
TOOL_REGISTRY: Dict[str, Callable[..., str]] = {
    "list_dir": list_dir,
    "read_file": read_file,
    "write_file": write_file,
    "bash": bash,
}


# ---------------------------------------------------------------- 给模型看的 schema

# 注意：description 写得越具体，模型调对的概率越高。
# 「什么时候用这个工具、用错了会怎样」比「这个工具能干什么」更重要。
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": (
                "列出工作区内某个目录下的文件和子目录。"
                "在不知道文件在哪、或不确定文件名时，一定要先调用它，不要凭猜测读写。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区根目录的路径。查看根目录请传 '.'。",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "读取一个文本文件的内容，返回带行号的文本。"
                "修改文件之前必须先读它，不要凭空覆盖。文件很长时可以分段读取。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区根目录的文件路径，例如 'notes/a.md'。",
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "起始行号，从 1 开始，默认 1。",
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "结束行号（含）。传 0 或不传表示读到文件末尾。",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "创建或覆盖一个文件，内容为完整文本。写大文件时如果怕被输出长度限制截断，"
                "可以拆成多次：先写主体，再用 bash 追加。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "相对工作区根目录的文件路径。父目录会自动创建。",
                    },
                    "content": {
                        "type": "string",
                        "description": "要写入的完整文件内容。",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": (
                "在工作区内执行一条 shell 命令，返回 stdout / stderr / exit code。"
                "适合批量操作（批量改名、批量替换、统计行数）和查看 git diff。"
                "批量任务优先写一条脚本一次做完，不要拆成很多次调用。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的 shell 命令，工作目录已被固定在项目根目录。",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "超时秒数，默认 30。",
                    },
                },
                "required": ["command"],
            },
        },
    },
]
