"""
AI vs AI 自对弈演示 —— 对应 JS 版的 selftest300.js
====================================================

跑一局（或几局）两个 AI 互相对弈的比赛，每一步打印：
- 棋盘（可选）
- 这步棋是谁、走了什么、引擎的评估/深度/节点数

学习要点：
1. argparse 命令行参数解析（标准库）
2. 用字典统计"重复局面"实现三次重复判和
3. 把引擎封装好的 search() 组装成完整对弈流程
4. 列表 + 队列式的历史管理（防死局的 avoid_keys）

运行方式：
    python selfplay.py                     # 默认看 1 局，每步思考 0.3 秒
    python selfplay.py --games 5 --delay 0 # 快速跑 5 局统计胜负（不看棋盘）
    python selfplay.py --budget 1000       # 每步思考 1 秒（更强）
"""

from __future__ import annotations

import argparse   # 标准库：命令行参数解析
import time

from engine import (DEAD, GREEN, INIT_POS, MAP_DEAD, NAMES, RED, WIN,
                    JungleEngine, pos_key)
from board_view import render_board, square_name

# 三同局面判和：同一局面 + 同一行棋方出现 3 次 → 和棋（防死局第一道防线）


def play_one_game(engine: JungleEngine, budget_ms: int, cap: int,
                  verbose: bool, delay: float) -> dict:
    """完整对弈一局，返回对局结果。

    :returns: {'winner': 0红/1绿/-1和, 'outcome': 结束原因, 'plies': 总手数}
    """
    pos = list(INIT_POS)              # 复制初始局面（list() 生成新列表，不影响原表）
    board = engine.board_from(pos)
    side = RED
    plies = 0
    stale_ply = 0                     # 自上次吃子以来的半回合数（防死局用）
    hist: list[str] = [pos_key(pos)]  # 近期局面指纹（传给引擎做重复惩罚）
    seen: dict[str, int] = {pos_key(pos) + '|' + str(RED): 1}  # 重复局面计数

    alive = [8, 8]                    # 双方存活棋子数

    while plies < cap:
        # ---- 三同局面判和 ----
        key = pos_key(pos) + '|' + str(side)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] >= 3:
            return {'winner': -1, 'outcome': 'repetition', 'plies': plies}

        # ---- 引擎思考 ----
        t0 = time.perf_counter()
        result = engine.search(pos, side, budget_ms=budget_ms,
                               avoid_keys=hist[-40:], stale_ply=stale_ply)
        ms = int((time.perf_counter() - t0) * 1000)
        m = result.move
        if m is None:
            return {'winner': 1 - side, 'outcome': 'noMoves', 'plies': plies}

        # ---- 在棋盘上执行这步棋（与引擎内部 apply_move 同一套） ----
        victim = board[m.to]
        board[pos[m.piece_id]] = MAP_DEAD
        board[m.to] = m.piece_id
        if victim >= 0:
            pos[victim] = DEAD
            alive[0 if victim < 8 else 1] -= 1
        pos[m.piece_id] = m.to

        # ---- 维护防死局状态 ----
        hist.append(pos_key(pos))
        if len(hist) > 40:
            hist.pop(0)
        stale_ply = 0 if victim >= 0 else stale_ply + 1

        # ---- 打印这步棋 ----
        if verbose:
            print(f'第{plies + 1:3d}手 {"红" if side == RED else "绿"} '
                  f'{NAMES[m.piece_id % 8]} {square_name(m.from_pos)}→{square_name(m.to)}'
                  f'{" 吃" + NAMES[victim % 8] if victim >= 0 else ""}'
                  f'  | 评估 {result.score / 1000:+.1f} 深度{result.depth} '
                  f'节点{result.nodes // 1000}k {ms}ms')
            if delay > 0:
                print(render_board(board, last_move=(m.from_pos, m.to)))
                time.sleep(delay)

        # ---- 胜负判定 ----
        if m.to == 3:                                  # 走进绿方兽穴(格3)
            return {'winner': RED, 'outcome': 'den', 'plies': plies + 1}
        if m.to == 59:                                 # 走进红方兽穴(格59)
            return {'winner': GREEN, 'outcome': 'den', 'plies': plies + 1}
        if alive[GREEN] == 0:
            return {'winner': RED, 'outcome': 'exterminate', 'plies': plies + 1}
        if alive[RED] == 0:
            return {'winner': GREEN, 'outcome': 'exterminate', 'plies': plies + 1}

        side = 1 - side                                # 换边
        plies += 1

    return {'winner': -1, 'outcome': 'cap', 'plies': plies}   # 300 回合未分胜负 = 死局判和


def main() -> None:
    """程序入口：解析命令行参数 → 循环对弈 → 打印统计。"""
    parser = argparse.ArgumentParser(description='斗兽棋 AI 自对弈演示')
    parser.add_argument('--games', type=int, default=1, help='对局数（默认 1）')
    parser.add_argument('--budget', type=int, default=300, help='每步思考毫秒数（默认 300）')
    parser.add_argument('--delay', type=float, default=0.4, help='每步停顿秒数，方便观看（默认 0.4，0=不看棋盘快速跑）')
    parser.add_argument('--cap', type=int, default=300, help='回合上限，超过判和（默认 300）')
    args = parser.parse_args()

    engine = JungleEngine(use_book=False)   # 自对弈双方对称公平，不开红方专属开局书
    wins = {RED: 0, GREEN: 0, -1: 0}
    outcomes: dict[str, int] = {}
    rounds_list: list[int] = []

    for g in range(args.games):
        r = play_one_game(engine, args.budget, args.cap,
                          verbose=args.games == 1 or args.delay > 0, delay=args.delay)
        wins[r['winner']] += 1
        outcomes[r['outcome']] = outcomes.get(r['outcome'], 0) + 1
        rounds_list.append(r['plies'])
        name = '和棋' if r['winner'] == -1 else ('红方' if r['winner'] == RED else '绿方')
        print(f'—— 第 {g + 1} 局结束：{name}胜（{r["outcome"]}），共 {r["plies"]} 手 ——\n')

    # ---- 汇总统计（对应 selftest300.js 的 summary）----
    total = args.games
    print('===== 汇总 =====')
    print(f'先手红 {wins[RED]}（{wins[RED] / total:.1%}） | '
          f'后手绿 {wins[GREEN]}（{wins[GREEN] / total:.1%}） | '
          f'和棋 {wins[-1]}（{wins[-1] / total:.1%}）')
    print(f'结束方式：{outcomes}')
    print(f'平均回合数 {sum(rounds_list) / total:.1f} | 最长 {max(rounds_list)}')


if __name__ == '__main__':
    # 这行是 Python 的惯用写法：只有直接运行本文件时才执行 main()，
    # 被其他文件 import 时不会执行（方便复用 play_one_game 函数）
    main()
