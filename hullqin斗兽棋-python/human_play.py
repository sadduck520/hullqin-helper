"""
人机对战 —— 你在终端里执棋，与 AI 对弈
==========================================

运行方式：
    python human_play.py              # 你执红（先手）
    python human_play.py --side green # 你执绿（后手）
    python human_play.py --budget 2000  # AI 每步想 2 秒（更强）

走子输入格式：先输入出发格，再输入到达格，坐标是「列字母 + 行数字」：
    D9  →  选中 D9 的棋子（程序会列出它能走到哪）
    D9 D7  →  把 D9 的棋子走到 D7
    q  →  认输    l  →  列出己方所有可走棋
"""

from __future__ import annotations

import argparse
import time

from engine import (DEAD, GREEN, INIT_POS, MAP_DEAD, NAMES, RED,
                    JungleEngine, pos_key)
from board_view import parse_square, render_board, square_name


def ask_human_move(engine, board, pos, side):
    """交互式获取人类玩家的一步棋。返回 (piece_id, to)；输入 q 认输返回 None。

    注意 engine 要作为参数传进来：函数内部默认读不到别的函数里的局部变量
    （Python 作用域规则），显式传参是最清晰的做法。

    这个函数演示了 Python 的输入循环三件套：
    input() 读入 → try/except 容错 → 合法性校验后放行。
    """
    side_name = '红方' if side == RED else '绿方'
    while True:
        raw = input(f'\n[{side_name}] 请输入走法（如 D9 D7），单输坐标可查看可走格，q 认输：').strip()
        if raw.lower() in ('q', 'quit', 'resign'):
            return None
        tokens = raw.replace('->', ' ').replace(',', ' ').split()
        if not tokens:
            continue
        try:
            from_pos = parse_square(tokens[0])
        except ValueError as e:
            print(f'  ✗ {e}')
            continue

        # 单输一个坐标 → 列出该格棋子的所有可走目标（教学：异常处理 + 友好提示）
        if len(tokens) == 1:
            piece = board[from_pos]
            if piece < 0:
                print('  ✗ 那是空格')
                continue
            if (piece < 8) != (side == RED):
                print('  ✗ 那不是你的棋子')
                continue
            dests = engine.gen_moves(board, piece, from_pos)
            if not dests:
                print('  ✗ 这颗棋子无路可走')
                continue
            print('  可走：' + '  '.join(square_name(d) for d in dests))
            continue

        # 两个坐标 → 完整走法
        try:
            to_pos = parse_square(tokens[1])
        except ValueError as e:
            print(f'  ✗ {e}')
            continue
        piece = board[from_pos]
        if piece < 0 or (piece < 8) != (side == RED):
            print('  ✗ 出发格上没有你的棋子')
            continue
        if to_pos not in engine.gen_moves(board, piece, from_pos):
            print('  ✗ 这不是合法走法（可先单输出发格查看可走点）')
            continue
        return piece, to_pos


def main() -> None:
    parser = argparse.ArgumentParser(description='斗兽棋 人机对战')
    parser.add_argument('--side', choices=['red', 'green'], default='red',
                        help='你执哪方（默认红方先手）')
    parser.add_argument('--budget', type=int, default=1000,
                        help='AI 每步思考毫秒数（默认 1000，越大越强）')
    parser.add_argument('--depth', type=int, default=0,
                        help='固定搜索深度（0=按时间，默认）')
    args = parser.parse_args()

    human_side = RED if args.side == 'red' else GREEN
    engine = JungleEngine(use_book=True)      # AI 执红时享受开局书；你执红则用不到
    ai_side = 1 - human_side

    pos = list(INIT_POS)
    board = engine.board_from(pos)
    side = RED                                # 红方先行
    stale_ply = 0
    hist: list[str] = []
    plies = 0

    print('=== 斗兽棋 人机对战 ===')
    print(f'你执{"红方(先手)" if human_side == RED else "绿方(后手)"}，'
          f'AI 每步思考 {args.budget}ms')
    print('坐标：列 A-G，行 1-9（第 1 行在顶部）。输入如 D9 D7。\n')

    while True:
        print(f'—— 第 {plies + 1} 手 ——')
        print(render_board(board))

        if side == human_side:
            got = ask_human_move(engine, board, pos, side)
            if got is None:
                print('你认输了，AI 获胜！')
                break
            piece, to = got
            victim = board[to]
            m_from = pos[piece]
            print(f'你走了 {NAMES[piece % 8]} {square_name(m_from)}→{square_name(to)}')
        else:
            # AI 思考（防死局参数与自对弈一致）
            t0 = time.perf_counter()
            result = engine.search(pos, side, budget_ms=args.budget,
                                   avoid_keys=hist[-40:], stale_ply=stale_ply,
                                   fixed_depth=args.depth)
            ms = int((time.perf_counter() - t0) * 1000)
            if result.move is None:
                print('AI 无棋可走，你获胜！')
                break
            piece, to = result.move.piece_id, result.move.to
            victim = board[to]
            m_from = pos[piece]
            print(f'AI 走了 {NAMES[piece % 8]} {square_name(m_from)}→{square_name(to)}'
                  f'  | 评估 {result.score / 1000:+.1f} 深度{result.depth} '
                  f'节点{result.nodes // 1000}k {ms}ms')

        # 在棋盘上执行（人机共用同一套落子逻辑）
        board[pos[piece]] = MAP_DEAD
        if victim >= 0:
            pos[victim] = DEAD
        board[to] = piece
        pos[piece] = to
        hist.append(pos_key(pos))             # 局面指纹：传给引擎防死局
        if len(hist) > 40:
            hist.pop(0)
        stale_ply = 0 if victim >= 0 else stale_ply + 1
        plies += 1

        # 胜负判定
        if to == 3 or to == 59:
            print(f'{"你" if side == human_side else "AI"}冲入兽穴，'
                  f'{"你赢" if side == human_side else "AI 赢"}了！')
            break
        red_alive = sum(1 for p in pos[:8] if 0 <= p < DEAD)
        green_alive = sum(1 for p in pos[8:] if 0 <= p < DEAD)
        if green_alive == 0 or red_alive == 0:
            winner = '你' if (red_alive > 0) == (human_side == RED) else 'AI'
            print(f'一方棋子被吃光，{winner}获胜！')
            break
        side = 1 - side


if __name__ == '__main__':
    main()
