"""
棋盘渲染与坐标换算 —— 把"数字棋盘"翻译成人能看懂的样子。

engine.py 里的棋盘是纯数字（board[格坐标] = 棋子编号或 -1），
终端里没法直接看，所以这个文件负责两件事：
1. render_board()：把数字棋盘画成一张带坐标的字符画
2. parse_square() / square_name()：人输入的坐标（如 D9）↔ 程序内部的数字（如 3）

这也是学习"模块拆分"的好例子：渲染逻辑（给人看）和引擎逻辑（算棋）
完全分离，各自独立修改互不影响。
"""

# 列标 A~G（对应内部列 0~6）
COLS = 'ABCDEFG'

# 棋子显示字符：红方大写、绿方小写（对应类型 0~7）
#   象=E/e  狮=L/l  虎=T/t  豹=P/p  狼=W/w  狗=D/d  猫=C/c  鼠=R/r
RED_CHARS = 'ELTPWDCR'
GREEN_CHARS = 'eltpwdcr'

# 特殊地形字符
CHAR_WATER = '~'   # 河流
CHAR_TRAP = 'x'    # 陷阱
CHAR_DEN = '#'     # 兽穴
CHAR_EMPTY = '.'   # 空地


def square_name(pos: int) -> str:
    """内部坐标（0~62）→ 人读的坐标（如 'D9'）。

    显示约定：列用字母 A~G（左→右），行用数字 1~9（上→下，
    即第 1 行是绿方底线、第 9 行是红方底线）。
    内部行 0 = 显示行 1（顶部），所以显示行 = 内部行 + 1。
    """
    return COLS[pos % 7] + str(pos // 7 + 1)


def parse_square(text: str) -> int:
    """人读的坐标（如 'D9'）→ 内部坐标（0~62）。输入非法时抛出 ValueError。"""
    text = text.strip().upper()
    if len(text) != 2 or text[0] not in COLS or text[1] not in '123456789':
        raise ValueError(f'坐标格式应为 列字母+行数字，例如 D9，收到：{text!r}')
    col = COLS.index(text[0])
    row = int(text[1]) - 1
    return row * 7 + col


def render_board(board: list[int], last_move: tuple[int, int] | None = None) -> str:
    """把 63 格数字棋盘画成一张字符画。

    :param board: 63 格棋盘数组（board[格] = 棋子编号或 -1）
    :param last_move: (出发格, 到达格)，会用 * 号标注这一步的起止点
    :return: 多行字符串，可直接 print()

    地形是固定的（斗兽棋棋盘不会变），直接用双重循环逐格判断：
    - 河流 ~：列 1-2/4-5 且行 3-5（行列都从 0 数）
    - 兽穴 #：绿方 (0,3)、红方 (8,3)
    - 陷阱 x：每方兽穴上方/左右的三个格子
    """
    lines = []
    # 表头：列标 A~G
    lines.append('     ' + ' '.join(COLS))
    for row in range(9):
        line_parts = [f' {row + 1} ']                 # 行标 1~9
        for col in range(7):
            pos = row * 7 + col
            ch = CHAR_EMPTY                            # 默认空地
            if (1 <= col <= 2 or 4 <= col <= 5) and 3 <= row <= 5:
                ch = CHAR_WATER                        # 河流
            if (row, col) == (0, 3) or (row, col) == (8, 3):
                ch = CHAR_DEN                          # 兽穴
            if pos in (58, 60, 52, 2, 4, 10):
                ch = CHAR_TRAP                         # 六个陷阱格
            # 若该格有棋子，用地形字符换成棋子字母（大写红 / 小写绿）
            v = board[pos]
            if v >= 0:
                ch = RED_CHARS[v] if v < 8 else GREEN_CHARS[v - 8]
            # 最后一手棋的起止点用 * 标注（盖在棋子上方也用小写 * 提示）
            if last_move and pos in last_move:
                line_parts.append(f' {ch}*')
            else:
                line_parts.append(f' {ch} ')
        lines.append(''.join(line_parts))
    lines.append('')
    lines.append('红方(大写) E象 L狮 T虎 P豹 W狼 D狗 C猫 R鼠 | '
                 '绿方(小写) 同名小写 | ~河 x陷阱 #兽穴 | *上一手')
    return '\n'.join(lines)
