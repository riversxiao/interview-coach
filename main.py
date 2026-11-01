# -*- coding: utf-8 -*-
"""
入口。

用法：
    python main.py "把 workspace 下的所有 .txt 合并成一个 all.md，并加一级标题"
    python main.py                       # 交互式输入

注意：load_dotenv() 必须在 import agent 之前执行，
因为 tools.py 在导入时就会读取 WORKSPACE_DIR 环境变量。
"""

import argparse
import sys

from dotenv import load_dotenv

load_dotenv()

from agent import run_agent  # noqa: E402
from tools import WORKSPACE  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="一个最小可运行的 Agent 运行时 demo")
    parser.add_argument("task", nargs="*", help="要交给 Agent 的任务描述")
    parser.add_argument("--max-turns", type=int, default=25, help="最大循环轮数，默认 25")
    args = parser.parse_args()

    task = " ".join(args.task).strip()
    if not task:
        task = input("任务> ").strip()
    if not task:
        print("没有任务，退出。")
        sys.exit(1)

    print(f"工作区: {WORKSPACE}")
    print(f"任务  : {task}")

    result = run_agent(task, max_turns=args.max_turns)

    print(f"\n{'=' * 60}")
    print("最终结论：")
    print(result)


if __name__ == "__main__":
    main()
