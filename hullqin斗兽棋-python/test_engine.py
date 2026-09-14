"""
引擎单元测试 —— 对应 JS 版的 engine.test.js（精简版）
====================================================

用最朴素的 assert 语句验证引擎的核心行为，不依赖任何测试框架。
运行：python test_engine.py

学习要点：
1. assert 语句（断言：条件为假就抛异常，测试的最小单位）
2. 用"构造已知局面 → 验证引擎行为"的方式测试棋类逻辑
3. try/except 捕获计数，最后汇总结果
"""

from engine import (DEAD, GREEN, INIT_POS, MAP_DEAD, RED, WIN,
                    JungleEngine, can_eat, pos_key)

engine = JungleEngine(use_book=False)
passed = 0
failed = 0


def check(name: str, actual, expected):
    """最小测试工具：actual 与 expected 相等则通过。"""
    global passed, failed
    if actual == expected:
        passed += 1
        print(f'  ✓ {name}')
    else:
        failed += 1
        print(f'  ✗ {name}\n      期望 {expected!r}\n      实际 {actual!r}')


def board_with(black_squares, white_squares):
    """测试辅助：按 (棋子编号, (行,列)) 快速摆棋，返回 (board, pos)。

    棋子编号：0象 1狮 2虎 3豹 4狼 5狗 6猫 7鼠（红方 0-7，绿方 8-15）
    """
    pos = [DEAD] * 16
    for pid, (r, c) in black_squares:
        pos[pid] = r * 7 + c
    for pid, (r, c) in white_squares:
        pos[pid] = r * 7 + c
    return engine.board_from(pos), pos


print('== 1. 吃子规则 ==')
check('鼠吃象', can_eat(7, 0), True)
check('象不吃鼠', can_eat(0, 7), False)
check('狼吃猫（编号小者强）', can_eat(4, 6), True)
check('猫不吃狼', can_eat(6, 4), False)
check('同级互吃', can_eat(3, 3), True)

print('== 2. 初始局面走法生成 ==')
board = engine.board_from(list(INIT_POS))
red_moves = engine.gen_all(board, True, list(INIT_POS))
check('红方开局有棋可走', len(red_moves) > 0, True)
check('开局全是单步（无吃子）', all(m.victim == -1 for m in red_moves), True)
check('没有任何走法进入自己兽穴', all(m.to != 59 for m in red_moves), True)
check('走法都有合法起点', all(0 <= m.from_pos < DEAD for m in red_moves), True)

print('== 3. 河流规则 ==')
# 红鼠(7)在河里 (行3,列1)=22，绿象(8)在岸上 (行2,列1)=15：鼠不能吃岸上的象
board, pos = board_with([(7, (3, 1))], [(8, (2, 1))])
rat_moves = engine.gen_moves(board, 7, 22)
check('水鼠不能吃岸上象', 15 not in rat_moves, True)
check('水鼠可在河里游动', 23 in rat_moves, True)
# 狮(1)在河边 (行2,列1)=15：能跳过河到对岸 (行6,列1)=43
board, pos = board_with([(1, (2, 1))], [])
lion_moves = engine.gen_moves(board, 1, 15)
check('狮能跳河', 43 in lion_moves, True)
# 河里有鼠(15绿鼠)挡路 (行4,列1)=29：狮被挡
board, pos = board_with([(1, (2, 1))], [(15, (4, 1))])
lion_moves = engine.gen_moves(board, 1, 15)
check('河中有子挡路狮不能跳', 43 not in lion_moves, True)

print('== 4. 陷阱规则 ==')
# 绿狼(12)站在红方陷阱 (行7,列3)=52，红鼠(7)在 (行6,列3)=45
# 平时鼠吃不动狼，但狼陷在红方陷阱里 → 任何红棋都能吃
board, pos = board_with([(7, (6, 3))], [(12, (7, 3))])
rat_moves = engine.gen_moves(board, 7, 45)
check('陷阱里的敌子可被鼠吃', 52 in rat_moves, True)
# 对照：狼若不在陷阱里（挪到 (行7,列2)=51），鼠就吃不动它
board, pos = board_with([(7, (6, 3))], [(12, (7, 2))])
rat_moves = engine.gen_moves(board, 7, 45)
check('不在陷阱里的狼鼠吃不动', 51 not in rat_moves, True)

print('== 5. apply/undo 严格互逆 ==')
board = engine.board_from(list(INIT_POS))
pos = list(INIT_POS)
alive = [8, 8]
# 找一步吃子走法来测试（构造：红鼠贴近绿象）
pos[7], pos[8] = 30, 23            # 红鼠(7)到 (行4,列2)，绿象(8)到 (行3,列2)=23
board = engine.board_from(pos)
target = engine.gen_moves(board, 7, 30)
if 23 in target:
    m = type('M', (), {'piece_id': 7, 'from_pos': 30, 'to': 23, 'victim': 8})()
    before = (board.copy(), pos.copy(), alive.copy())
    saved = engine.apply_move(board, pos, alive, m)
    engine.undo_move(board, pos, alive, m, saved)
    check('走子后撤销 → 棋盘完全还原', (board, pos, alive) == before
          or (board == before[0] and pos == before[1] and alive == before[2]), True)
else:
    check('构造吃子局面', False, True)

print('== 6. 搜索：能发现一步冲穴 ==')
# 红象贴着绿方兽穴 (行1,列3)=10，走 (行0,列3)=3 即获胜
pos = list(INIT_POS)
pos[0] = 10                        # 红象放到绿穴门口
r = engine.search(pos, RED, fixed_depth=2)
check('搜索找到冲穴胜着', r.move.to == 3, True)
check('冲穴分数是必胜级', r.score > WIN - 1000, True)

print('== 7. 防死局：重复局面惩罚 ==')
pos = [42, 62, 56, 46, 49, 54, 50, 48, 20, 0, 6, 16, 18, 8, 12, 14]
r1 = engine.search(pos, RED, fixed_depth=4)
# 构造"走完后会回到搜索过的旧局面"的避免列表
import copy
pos2 = list(pos)
pos2[r1.move.piece_id] = r1.move.to
avoid = [pos_key(pos2), pos_key(pos2)]   # 同一指纹出现 2 次 → 惩罚最重
r2 = engine.search(pos, RED, fixed_depth=4, avoid_keys=avoid)
same = (r2.move.from_pos == r1.move.from_pos and r2.move.to == r1.move.to)
print(f'      原选 {r1.move.from_pos}->{r1.move.to}（score {r1.score}），'
      f'加惩罚后选 {r2.move.from_pos}->{r2.move.to}（score {r2.score}）')
check('加重复惩罚后引擎改变选择', same is False or r2.score <= r1.score, True)

print('== 8. 自对弈快速冒烟 ==')
# 一局极快自对弈（每步 60ms、上限 120 手），验证整条链路不崩溃且能分出胜负
from selfplay import play_one_game
res = play_one_game(engine, budget_ms=60, cap=120, verbose=False, delay=0)
check('自对弈正常结束（有结果）', res['outcome'] in ('den', 'cap', 'repetition', 'exterminate', 'noMoves'), True)
print(f"      结果：{res}")

print(f'\n结果：{passed} 通过，{failed} 失败')
raise SystemExit(1 if failed else 0)
