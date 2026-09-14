"""
斗兽棋引擎核心（Python 教学版）—— 对应 JS 版的 engine.core.js
=================================================================

这个文件是整个项目的"大脑"：它知道斗兽棋的全部规则（哪些棋子能走到哪、
谁能吃谁），并且会用 negamax 极小极大搜索 + α-β 剪枝 + 静态搜索 + 置换表
来挑选最好的走法。它与 JS 版算法完全一致，只是换成了 Python 语法。

【学习方法建议】
1. 先读「常量区」和「规则区」，理解棋盘的表示方法（这是所有棋类程序的基础）
2. 再读「评估函数」——它把"局面好坏"翻译成一个数字
3. 最后读「搜索区」——negamax 是所有棋类 AI 的核心算法

【用到的 Python 知识点】（配合 README.md 的知识点索引阅读）
- 常量与变量、整数/字符串/布尔、列表 list、集合 set、字典 dict
- 函数定义 def、默认参数、类型注解（-> bool、: list[int]）
- 类 class 与 self、@dataclass 数据类、@staticmethod 静态方法
- f-string 格式化、循环 for/while、break/continue
- time.perf_counter() 计时、枚举 enumerate、推导式
- 整数位运算 &（对应 JS 的 & 511 节流技巧）

本文件不依赖任何第三方库，也不依赖图形界面，纯标准库。
"""

from __future__ import annotations  # 让类型注解可以用 list[int] 等新写法（3.7+）

import time                        # 标准库：时间，用于搜索的时间预算控制
from dataclasses import dataclass  # 标准库：数据类，用来自动生成简单的"数据载体"类

# ============================================================================
# 一、常量区 —— 棋盘与棋子的基本设定（与 JS 版完全一致）
# ============================================================================

DEAD = 63        # 一个"哨兵"坐标：表示棋子已经死了（棋盘只有 0~62 格，63 在棋盘外）
MAP_DEAD = -1    # 棋盘数组里表示"空格"的值
RED, GREEN = 0, 1  # 双方阵营：0 = 红方（先手），1 = 绿方（后手）

# 初始局面：16 个棋子的位置（对应游戏源码 LC() 函数）
# 下标 0~7 是红方的 象狮虎豹狼狗猫鼠，下标 8~15 是绿方的同名棋子
# 位置的计算方式：pos = 行 * 7 + 列（棋盘 7 列 9 行，行 0 在最上面）
INIT_POS: list[int] = [42, 62, 56, 46, 44, 54, 50, 48, 20, 0, 6, 16, 18, 8, 12, 14]

# 双方的兽穴位置：红方兽穴在 (行8,列3) → 8*7+3=59；绿方兽穴在 (行0,列3) → 3
# 任何一个棋子走进"对方的"兽穴，直接获胜
DENS: list[int] = [59, 3]

# 双方的陷阱位置（集合 set：查找速度 O(1)，适合"判断在不在"）
# 站进"对方的"陷阱的棋子会失去战斗力（任何棋子都能吃它）
TRAPS: list[set[int]] = [
    {8 * 7 + 2, 8 * 7 + 4, 7 * 7 + 3},   # 红方陷阱（在绿方半场）
    {0 * 7 + 2, 0 * 7 + 4, 1 * 7 + 3},   # 绿方陷阱（在红方半场）
]

# 四个移动方向：每一项是 (列变化 dCol, 行变化 dRow)
DIRS: list[tuple[int, int]] = [(0, -1), (0, 1), (-1, 0), (1, 0)]

# 棋子名字（下标 = 棋子类型 0~7）：类型编号越小越强
NAMES: list[str] = ['象', '狮', '虎', '豹', '狼', '狗', '猫', '鼠']

# 每种棋子的基础价值（评估函数用它衡量"子力"）
VAL: list[int] = [650, 520, 470, 350, 270, 230, 200, 190]

WIN = 10_000_000      # "必胜"级别的分数（Python 允许数字中间加下划线提高可读性）
QLIMIT = 16           # 静态搜索里吃子链的最大长度（防止无限递归）
TT_MAX = 200_000      # 置换表最大条目数（超过就清空，防止内存无限增长）
TT_MATE = WIN - 1000  # 分数达到这个级别就说明是"杀棋分数"，需要做距离修正
REP_PATH_SCORE = -24  # 搜索路径上遇到重复局面的惩罚分（轻微负分：来回走无意义）

# 河流区域判定：列在 1~2 或 4~5，行在 3~5 之间就是河
# 注意这是一个"lambda 表达式"——匿名小函数，等价于 def is_water(c, r): return ...
is_water = lambda col, row: ((1 <= col <= 2) or (4 <= col <= 5)) and 3 <= row <= 5


# ============================================================================
# 二、数据结构 —— 用 @dataclass 定义"一步棋"
# ============================================================================
# @dataclass 是 Python 3.7+ 的语法：装饰器会自动生成 __init__、__repr__ 等方法，
# 免去手写重复代码。每条注释对应一个字段。
@dataclass
class Move:
    """一步棋：哪个棋子（piece_id）从哪里（from_pos）走到哪里（to），吃掉了谁（victim）"""
    piece_id: int          # 棋子编号 0~15（0~7 红，8~15 绿；编号 % 8 = 类型）
    from_pos: int          # 出发格（0~62）。注意：不能叫 from，因为 from 是 Python 关键字！
    to: int                # 目标格（0~62）
    victim: int            # 被吃的棋子编号；-1 表示这步棋不吃子


@dataclass
class SearchResult:
    """搜索结果：最佳走法 + 评分 + 一些统计信息"""
    move: Move | None      # 最佳走法；None 表示无棋可走（Python 3.10+ 的"联合类型"写法）
    score: int             # 分数：正数 = 行棋方占优
    depth: int             # 实际搜索完成的深度
    nodes: int             # 搜索过的节点数（性能指标）
    ms: int                # 耗时（毫秒）


# ============================================================================
# 三、规则区 —— "哪些走法是合法的"
# ============================================================================

def can_eat(att_type: int, def_type: int) -> bool:
    """判断攻击方棋子（att_type）能否吃掉防守方棋子（def_type）。

    斗兽棋吃子规则（特殊之处用注释标出）：
    - 鼠(7) 可以吃 象(0)        —— 唯一的"以小吃大"
    - 象(0) 不能吃 鼠(7)        —— 象的天敌
    - 其余情况：编号小的吃编号小的等（同级可互吃）
    """
    if att_type == 7 and def_type == 0:
        return True            # 鼠吃象：特例
    if att_type == 0 and def_type == 7:
        return False           # 象不吃鼠：特例
    return att_type <= def_type  # 通用规则：编号小者强，同级互吃


def pos_key(pos: list[int]) -> str:
    """把局面（16 个棋子的位置数组）转成一个字符串"指纹"。

    用途：① 置换表查重 ② 判断重复局面（防止来回走死循环）。
    ','.join(map(str, pos)) 是 Python 的经典写法：
      map(str, pos) 把每个数字变成字符串，再逗号连接 → '42,62,56,...'
    """
    return ','.join(map(str, pos))


# ============================================================================
# 四、引擎主体 —— 一个类封装规则 + 评估 + 搜索
# ============================================================================

class JungleEngine:
    """斗兽棋引擎。

    设计说明（对应 JS 版的"工厂函数返回一组闭包函数"）：
    JS 用闭包共享 board/pos/alive 等搜索状态；Python 更自然的写法是把状态
    放在类的实例属性里（self._board 等），搜索时自顶向下传递同一个状态。
    这也顺便演示了 Python 类的核心思想：数据（属性）+ 操作（方法）打包在一起。
    """

    def __init__(self, use_book: bool = True):
        """
        :param use_book: 是否启用迷你开局书（红方第一手直接走 狮 62→55，
                         这是 400 局自对弈统计出来的最优首步）
        """
        self.use_book = use_book
        self.tt: dict[str, dict] = {}   # 置换表：局面指纹 → {d:深度, v:分值, f:标志, m:最佳走法}

    # ------------------------------------------------------------------
    # 4.1 基础工具
    # ------------------------------------------------------------------

    def board_from(self, pos: list[int]) -> list[int]:
        """由 16 个棋子的位置数组，生成 63 格的棋盘数组。

        两种数组的区别（棋类程序的常见双表示技巧）：
        - board（63 格）：board[格坐标] = 棋子编号或 -1 → 快速回答"这格上是谁"
        - pos   (16 格)：pos[棋子编号] = 格坐标           → 快速枚举每个棋子的位置
        两者互为反向索引，走子时同步更新。
        """
        board = [MAP_DEAD] * 63          # 先全部填成"空格"（[x]*n 是列表快速初始化）
        for i in range(16):
            p = pos[i]
            if 0 <= p < DEAD:            # 等价于 JS 的 p >= 0 && p < DEAD
                board[p] = i             # 该格放着编号为 i 的棋子
        return board

    def _move_score(self, m: Move, side: int) -> int:
        """走法排序打分（MVV-LVA 思想：Most Valuable Victim / Least Valuable Attacker）。

        搜索时先尝试"看起来最好"的走法，能让 α-β 剪枝剪掉更多分支。
        - 走进对方兽穴 = 直接赢，给一个超大分（绝对优先尝试）
        - 吃子：吃掉的子越值钱（ victim 值 ×10 ）、攻击子越便宜（ 减去 attacker/10 ）越好
        - 普通走法：0 分
        """
        den = DENS[GREEN if side == RED else RED]      # 对方兽穴
        if m.to == den:
            return 1_000_000
        if m.victim >= 0:
            return VAL[m.victim % 8] * 10 - VAL[m.piece_id % 8] // 10
        return 0

    # ------------------------------------------------------------------
    # 4.2 走子生成 —— 严格复刻游戏规则（对应 JS 的 genMoves）
    # ------------------------------------------------------------------

    def gen_moves(self, board: list[int], piece_id: int, known_pos: int | None = None) -> list[int]:
        """生成某个棋子的全部合法目标格。

        规则要点（逐条对应下面的代码）：
        1. 只能上下左右走一格
        2. 不能走进自己的兽穴
        3. 只有鼠(7)能进河；狮(1)虎(2)可以沿直线"跳河"（河里没子挡路才行）
        4. 河里的鼠不能直接吃岸上的非鼠棋子
        5. 目标格有敌子时：若敌子在我方陷阱里 → 随便吃；否则按 can_eat 判定
        """
        res: list[int] = []                          # 收集所有合法目标格
        is_red = piece_id < 8

        # 确定棋子当前在哪格：调用方若已知位置（known_pos）就直接用，否则扫描棋盘
        pos = known_pos
        if pos is None or board[pos] != piece_id:
            pos = -1
            for p in range(63):
                if board[p] == piece_id:
                    pos = p
                    break
        if pos is None or pos < 0:
            return res                               # 找不到这颗棋子（已死）→ 无走法

        col, row = pos % 7, pos // 7                 # % 取列，// 取行（divmod 亦可）
        ptype = piece_id % 8
        own_den = DENS[RED if is_red else GREEN]     # 自己的兽穴（不能进）
        my_traps = TRAPS[RED if is_red else GREEN]   # 自己布的陷阱（敌子进来可随便吃）

        for dc, dr in DIRS:                          # Python 的元组解包遍历
            c, r = col + dc, row + dr
            if c < 0 or c > 6 or r < 0 or r > 8:
                continue                             # 越界（棋盘 7 列 9 行）
            if r * 7 + c == own_den:
                continue                             # 规则 2：不能进自己兽穴

            # ---- 河流的特殊处理 ----
            if is_water(c, r):
                if ptype in (1, 2):                  # 狮 / 虎：尝试跳河
                    blocked = False
                    while is_water(c, r):            # 沿着河一路走
                        if board[r * 7 + c] != MAP_DEAD:
                            blocked = True           # 河里有子挡路（哪怕是自己人）
                            break
                        c += dc
                        r += dr
                    if blocked or c < 0 or c > 6 or r < 0 or r > 8:
                        continue                     # 被挡住或跳到界外 → 此路不通
                elif ptype != 7:
                    continue                         # 规则 3：其他棋子不能下水

            target = board[r * 7 + c]                # 目标格上的东西
            if target >= 0 and (target < 8) == is_red:
                continue                             # 目标格是己方棋子 → 不能走

            if target >= 0:                          # 目标格有敌子 → 判断能不能吃
                # 规则 4：水里的鼠上岸吃子受限（只能吃岸上的鼠）
                if (ptype == 7 and is_water(col, row)
                        and not is_water(c, r) and target % 8 != 7):
                    continue
                if r * 7 + c in my_traps:            # 规则 5：敌子在我方陷阱 → 随便吃
                    res.append(r * 7 + c)
                    continue
                if can_eat(ptype, target % 8):       # 常规大小判定
                    res.append(r * 7 + c)
            else:                                    # 空格 → 直接可走
                res.append(r * 7 + c)
        return res

    def gen_all(self, board: list[int], is_red: bool, pos16: list[int] | None = None) -> list[Move]:
        """生成某一方全部合法走法。

        :param pos16: 若提供棋子位置数组就免于扫描棋盘（性能优化，搜索时全程携带）
        """
        moves: list[Move] = []
        # range(0,8) 是红方 8 个子，range(8,16) 是绿方 8 个子
        for i in range(0 if is_red else 8, 8 if is_red else 16):
            from_pos = pos16[i] if pos16 is not None else None
            if pos16 is not None and not (0 <= from_pos < DEAD):
                continue                              # 该棋子已死，跳过
            # 已知位置时传入 known_pos，避免 gen_moves 内部再扫描一遍
            targets = self.gen_moves(board, i, from_pos if pos16 is not None else None)
            for to in targets:
                moves.append(Move(piece_id=i, from_pos=from_pos if pos16 is not None else -1,
                                  to=to, victim=board[to]))
        return moves

    # ------------------------------------------------------------------
    # 4.3 走子 / 撤销 —— 搜索的"时光机"
    # ------------------------------------------------------------------

    def apply_move(self, board: list[int], pos: list[int], alive: list[int], m: Move) -> tuple:
        """在棋盘上执行一步棋，返回"撤销所需的信息"。

        搜索算法不复制棋盘，而是"走一步→搜→撤销一步"（make/unmake 模式），
        这是棋类引擎最重要的性能技巧之一。alive 记录双方存活棋子数。
        """
        prev = (pos[m.piece_id], board[m.to])        # 元组：(出发格, 目标格原来的东西)
        board[pos[m.piece_id]] = MAP_DEAD            # 出发格清空
        board[m.to] = m.piece_id                     # 目标格放上棋子
        pos[m.piece_id] = m.to                       # 更新棋子位置
        if prev[1] >= 0:                             # 吃到子了
            pos[prev[1]] = DEAD                      # 被吃棋子标记为死亡
            alive[RED if prev[1] < 8 else GREEN] -= 1
        return prev

    def undo_move(self, board: list[int], pos: list[int], alive: list[int], m: Move, prev: tuple) -> None:
        """精确撤销 apply_move 做过的每一件事（顺序相反）。

        只要 apply/undo 严格互逆，搜索就能安全地"回到过去"。
        这是初学者最容易写错的地方：漏还原任何一个数组都会导致诡异 bug。
        """
        board[m.to] = prev[1]                        # 目标格还原（可能是被吃棋子或空）
        board[prev[0]] = m.piece_id                  # 出发格放回棋子
        pos[m.piece_id] = prev[0]
        if prev[1] >= 0:
            pos[prev[1]] = m.to
            alive[RED if prev[1] < 8 else GREEN] += 1

    # ------------------------------------------------------------------
    # 4.4 评估函数 —— 把局面翻译成一个数字（正 = 红方好，负 = 绿方好）
    # ------------------------------------------------------------------

    def evaluate(self, board: list[int], pos: list[int]) -> int:
        """静态评估：不往下搜索，只看当前局面给个分数。

        评估的组成（从上到下权重递增）：
        1. 子力：每个棋子的基础价值；鼠在对方还有象时更值钱（+110 / -60）
        2. 推进分：离敌穴越近越好，狮虎的推进权重更高（它们能跳河）
        3. 冲穴分：距离敌穴 ≤4 步时额外加速奖励
        4. 兽穴门口的重压：距敌穴 ≤2 步时给予巨额奖励（接近获胜）
        5. 陷阱危险：深入敌方陷阱要扣分；旁边有敌子守着则重扣
        """
        score = 0
        # 先扫描一遍：双方是否还有"象"（鼠的价值取决于对面有没有象）
        red_ele = False
        green_ele = False
        for i in range(16):
            p = pos[i]
            if 0 <= p < DEAD and i % 8 == 0:        # i%8==0 → 这是"象"
                if i < 8:
                    red_ele = True
                else:
                    green_ele = True

        for i in range(16):
            p = pos[i]
            if not (0 <= p < DEAD):
                continue                             # 死子跳过
            side = RED if i < 8 else GREEN
            ptype = i % 8
            col, row = p % 7, p // 7

            v = VAL[ptype]
            if ptype == 7:                           # 鼠的价值是动态的
                opp_has_ele = green_ele if side == RED else red_ele
                v += 110 if opp_has_ele else -60     # 对面有象 → 鼠很珍贵；否则略贬值

            # 推进：曼哈顿距离（行列差绝对值之和）到对方兽穴
            den = DENS[GREEN if side == RED else RED]
            dist = abs((den // 7) - row) + abs((den % 7) - col)
            adv = (12 - dist) * (5 if ptype in (1, 2) else 4)   # 狮虎推进更快
            if dist <= 4:
                adv += (5 - dist) * 10               # 接近敌穴：额外冲穴奖励
            if dist <= 2:
                adv += (3 - dist) * 150              # 兽穴门口的重压

            # 陷阱危险：站进敌方陷阱 → 轻扣；旁边有敌子 → 重扣（随时会被吃）
            enemy_traps = TRAPS[GREEN if side == RED else RED]
            if p in enemy_traps:
                v -= VAL[ptype] * 0.15
                for dc, dr in DIRS:
                    c, r = col + dc, row + dr
                    if 0 <= c <= 6 and 0 <= r <= 8:
                        q = board[r * 7 + c]
                        if q >= 0 and (q < 8) != (side == RED):
                            v -= VAL[ptype] * 0.55
                            break

            # 红方加分、绿方减分（同一套公式，视角取反）
            score += (1 if side == RED else -1) * (v + adv)
        return int(score)

    # ------------------------------------------------------------------
    # 4.5 搜索区 —— 引擎的"思考"过程
    # ------------------------------------------------------------------

    def search(self, pos16: list[int], side: int, budget_ms: int = 600,
               avoid_keys: list[str] | None = None, stale_ply: int = 0,
               fixed_depth: int = 0, max_depth: int = 14) -> SearchResult:
        """搜索入口：给定局面，返回最佳走法。

        :param pos16:      16 个棋子的位置数组（局面）
        :param side:       轮到哪方走（RED / GREEN）
        :param budget_ms:  思考时间预算（毫秒）。迭代加深会在这个时间内逐层加深
        :param avoid_keys: 近期局面指纹列表 → 重复出现的走法会被扣分（防死局）
        :param stale_ply:  自上次吃子以来的半回合数（领先方会因此被催促进攻）
        :param fixed_depth: >0 时固定搜索深度、不限时（测试用）
        :param max_depth:  时间模式下允许的最大深度
        """
        t0 = time.perf_counter()                     # 高精度计时器
        self._pos: list[int] = list(pos16)           # 复制一份（浅拷贝即可，元素是整数）
        self._board = self.board_from(self._pos)
        self._alive = [0, 0]
        for i in range(16):
            p = self._pos[i]
            if 0 <= p < DEAD:
                self._alive[RED if i < 8 else GREEN] += 1

        self._side_root = side
        self._stale_ply = stale_ply
        self._nodes = 0
        self._aborted = False
        self._deadline = (t0 + budget_ms / 1000) if fixed_depth <= 0 else float('inf')
        depth_limit = min(max(2, fixed_depth), 30) if fixed_depth > 0 else max_depth

        # 历史重复统计：指纹 → 出现次数（字典推导式 + 计数）
        rep_count: dict[str, int] = {}
        if avoid_keys:
            for k in avoid_keys:
                rep_count[k] = rep_count.get(k, 0) + 1

        # 迷你开局书：红方在初始局面的第一手直接用统计最优解
        if (self.use_book and side == RED
                and list(pos16) == INIT_POS):
            return SearchResult(move=Move(1, 62, 55, -1), score=0, depth=0, nodes=0, ms=0)

        root_moves = self.gen_all(self._board, side == RED, self._pos)
        if not root_moves:
            return SearchResult(move=None, score=-WIN, depth=0, nodes=0,
                                ms=int((time.perf_counter() - t0) * 1000))
        for m in root_moves:
            m._s = self._move_score(m, side)
        root_moves.sort(key=lambda m: m._s, reverse=True)

        # 根节点：计算每步棋走完后的局面重复次数（用于动态扣分）
        for m in root_moves:
            saved = self.apply_move(self._board, self._pos, self._alive, m)
            m._rep = rep_count.get(pos_key(self._pos), 0)
            self.undo_move(self._board, self._pos, self._alive, m, saved)
        root_moves.sort(key=lambda m: m._rep)         # 重复的走法排到最后

        # 搜索路径上的局面集合（防树内来回走）
        root_pk = pos_key(self._pos)
        self._path: set[str] = {root_pk}

        # ---- 迭代加深：从浅到深反复搜索，时间到了就用上一轮的完整结果 ----
        best_move, best_score, finished_depth = root_moves[0], 0, 0
        for depth in range(2, depth_limit + 1):
            iter_best, iter_score = None, float('-inf')
            alpha = float('-inf')
            ordered = [best_move] + [m for m in root_moves if m is not best_move]  # 上轮最佳优先
            self._path.clear()                        # 每轮重置路径集合（上轮可能中途超时残留）
            self._path.add(root_pk)
            for m in ordered:
                saved = self.apply_move(self._board, self._pos, self._alive, m)
                if m.to == DENS[GREEN if side == RED else RED] or self._alive[1 if side == RED else 0] == 0:
                    score = WIN - 1                   # 走这步直接赢
                else:
                    score = -self._negamax(depth - 1, float('-inf'), -alpha,
                                           GREEN if side == RED else RED, 1)
                self.undo_move(self._board, self._pos, self._alive, m, saved)
                if self._aborted:
                    break
                # ---- 防死局：重复局面动态扣分 ----
                if m._rep:
                    pen = 200 + 500 * (m._rep - 1)    # 出现次数越多扣越狠
                    if score > 200:
                        pen *= 2                      # 我方明显占优 → 必须求变
                    elif score < -200:
                        pen = 40                      # 我方明显劣势 → 允许重复（求和）
                    score -= pen
                if score > iter_score:
                    iter_score, iter_best = score, m
                if score > alpha:
                    alpha = score
            if self._aborted:
                break
            best_move, best_score, finished_depth = iter_best, iter_score, depth
            if best_score > WIN - 1000 or best_score < -(WIN - 1000):
                break                                 # 已找到必胜/必败线，不用再加深

        ms = int((time.perf_counter() - t0) * 1000)
        return SearchResult(move=best_move, score=best_score, depth=finished_depth,
                            nodes=self._nodes, ms=ms)

    # ---- 下面三个方法是 search 的"内部机器"（下划线开头 = 类内私有约定）----

    def _time_up(self) -> bool:
        """时间检查：不必每个节点都查表（昂贵），每 512 个节点查一次即可。
        & 511 是位运算，等价于 nodes % 512 == 0，但更快。"""
        self._nodes += 1
        if self._nodes & 511:
            return False
        if time.perf_counter() > self._deadline:
            self._aborted = True
            return True
        return False

    def _stand_pat(self, side: int) -> int:
        """叶子评估（行棋方视角）+ 防死局的紧迫感。

        紧迫感机制：如果双方很久没吃子（stale_ply 大）说明局面在僵持，
        此时"领先的一方"被逐步扣分——逼它主动求变，避免双方来回走死局。
        """
        ev = self.evaluate(self._board, self._pos)
        if self._stale_ply >= 10:
            urg = min((self._stale_ply - 10) * 3, 90)
            if ev > 60:
                ev -= urg
            elif ev < -60:
                ev += urg
        return ev if side == RED else -ev               # 转成行棋方视角

    def _quiesce(self, alpha: float, beta: float, side: int, ply: int) -> int:
        """静态搜索（quiescence search）：深度用尽后，继续只搜"吃子"。

        为什么需要它？如果深度一到就立刻评估，引擎会看不到"刚吃完子会被反吃"
        的 tactics（水平线效应）。静态搜索把所有吃子交换链走完再评估，分数才稳定。
        """
        if self._time_up():
            return 0
        stand = self._stand_pat(side)                   # "站住不动"的分
        if stand >= beta:
            return stand                                # β 截断（对方不会让我走到这）
        if stand > alpha:
            alpha = stand
        moves = self.gen_all(self._board, side == RED, self._pos)
        if not moves:
            return -(WIN - ply)                         # 无棋可走 = 输
        den = DENS[GREEN if side == RED else RED]
        tactical = [m for m in moves if m.victim >= 0 or m.to == den]  # 只要吃子/冲穴
        if not tactical:
            return stand                                # 没有战术着法 → 静态分已稳定
        for m in tactical:
            m._s = self._move_score(m, side)
        tactical.sort(key=lambda m: m._s, reverse=True)
        best, n = stand, 0
        for m in tactical:
            n += 1
            if n > QLIMIT:
                break                                   # 吃子链太长就截断
            saved = self.apply_move(self._board, self._pos, self._alive, m)
            if m.to == den or self._alive[1 if side == RED else 0] == 0:
                score = WIN - ply - 1
            else:
                score = -self._quiesce(-beta, -alpha, GREEN if side == RED else RED, ply + 1)
            self.undo_move(self._board, self._pos, self._alive, m, saved)
            if self._aborted:
                return best
            if score > best:
                best = score
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break
        return best

    def _negamax(self, depth: int, alpha: float, beta: float, side: int, ply: int) -> int:
        """negamax 主搜索：我方得分 = -(对方最佳得分)。

        α-β 剪枝的含义：
        - alpha：当前行棋方已能保证的下限
        - beta ：对方允许的上限
        - 一旦 alpha >= beta，说明这条线对方绝不会允许发生 → 剪掉不再搜索
        """
        if self._time_up():
            return 0
        pk = pos_key(self._pos)
        # 树内重复检测：这条搜索路径上已经见过当前局面 → 来回走无意义
        if pk in self._path:
            return REP_PATH_SCORE

        # 置换表：不同搜索路径常会到达同一局面，直接复用旧结论（depth>=2 才值得）
        tt_key = pk + '|' + str(side) if depth >= 2 else None
        entry = self.tt.get(tt_key) if tt_key else None
        if entry and entry['d'] >= depth:
            v = entry['v']
            # 杀棋分数要按剩余深度修正（同样是将死，离根越近分越高）
            if v > TT_MATE:
                v -= ply
            elif v < -TT_MATE:
                v += ply
            if entry['f'] == 0:                       # 精确值
                return v
            if entry['f'] == 1 and v > alpha:          # 下界
                alpha = v
            elif entry['f'] == 2 and v < beta:         # 上界
                beta = v
            if alpha >= beta:
                return v

        alpha_orig = alpha
        moves = self.gen_all(self._board, side == RED, self._pos)
        if not moves:
            return -(WIN - ply)                        # 无棋可走 = 输
        for m in moves:
            m._s = self._move_score(m, side)
        moves.sort(key=lambda m: m._s, reverse=True)   # 好走法先搜 → 剪枝更多

        self._path.add(pk)
        best = float('-inf')
        for m in moves:
            saved = self.apply_move(self._board, self._pos, self._alive, m)
            if m.to == DENS[GREEN if side == RED else RED] or self._alive[1 if side == RED else 0] == 0:
                score = WIN - ply - 1                  # 冲穴 / 全歼
            elif depth <= 1:
                # 深度用尽 → 静态搜索把吃子链走完再评估（消除水平线效应）
                score = -self._quiesce(-beta, -alpha, GREEN if side == RED else RED, ply + 1)
            else:
                score = -self._negamax(depth - 1, -beta, -alpha,
                                       GREEN if side == RED else RED, ply + 1)
            self.undo_move(self._board, self._pos, self._alive, m, saved)
            if self._aborted:
                return 0
            if score > best:
                best = score
            if best > alpha:
                alpha = best
            if alpha >= beta:
                break                                  # β 截断：剪掉剩余走法
        self._path.discard(pk)                         # 回溯：把当前局面移出路径

        if tt_key and not self._aborted:
            if self.tt and len(self.tt) > TT_MAX:
                self.tt.clear()                        # 置换表满了就清空（简单可靠）
            flag = 2 if best <= alpha_orig else (1 if best >= beta else 0)
            v = best
            if v > TT_MATE:
                v += ply
            elif v < -TT_MATE:
                v -= ply
            self.tt[tt_key] = {'d': depth, 'v': v, 'f': flag}
        return best
