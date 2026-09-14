# 斗兽棋 AI —— Python 教学版

这是 `hullqin斗兽棋`（JS 版）的 **Python 复刻**，算法与 JS 引擎完全一致，
但每一行都为"Python 初学者能看懂"而写：密集的中文注释 + 知识点标注。

## 快速运行

```bash
cd hullqin斗兽棋-python

python test_engine.py                  # ① 跑 20 项引擎测试（确认一切正常）
python selfplay.py                     # ② 看 AI 和 AI 对弈（每步打印棋盘）
python selfplay.py --budget 1000       #    AI 每步想 1 秒（更强）
python selfplay.py --games 10 --delay 0#    快速跑 10 局统计先后手胜率
python human_play.py                   # ③ 你自己 vs AI（你执红先行）
python human_play.py --side green      #    你执绿后手
```

按 Ctrl+C 可随时中断。

## 文件结构（建议按此顺序阅读）

| 文件 | 对应 JS 版 | 内容 |
|---|---|---|
| `engine.py` | `engine.core.js` | **核心**：规则 + 评估 + negamax 搜索，全部知识在这 |
| `board_view.py` | （无对应，纯展示） | 把数字棋盘画成字符画 + 坐标换算 |
| `selfplay.py` | `selftest300.js` | AI vs AI 自对弈 + 胜负统计 |
| `human_play.py` | （无对应） | 人机终端对战 |
| `test_engine.py` | `engine.test.js` | 20 项单元测试 |

## 学习路线建议

1. **先玩**：跑 `python selfplay.py`，看 30 秒。你会看到两个 AI 每 0.4 秒走一步，
   棋盘下方打印每步的「评估分 / 搜索深度 / 节点数」——这就是引擎思考的痕迹。
2. **再读规则**：`engine.py` 的「常量区」和「走子生成」。理解棋盘如何用
   **两个数组** 表示（`board` 63 格查"这格是谁"、`pos` 16 格查"这子在哪"），
   这是所有棋类程序的通用手法。
3. **再读评估**：`evaluate()` 把局面翻译成一个数字。看完你就明白
   "AI 为什么觉得这步好"——全靠这些加减分规则。
4. **最后攻搜索**：`_negamax()` 是灵魂。"我方得分 = 负的对方最佳得分"，
   配合 α-β 剪枝（对方不会让我走到的那条线，剪掉不搜）。

## Python 知识点索引（学到什么去哪找）

| 知识点 | 在哪看 |
|---|---|
| 变量 / f-string 格式化 | 随处可见，`selfplay.py` 的打印最密集 |
| 列表 list（含 `[x] * n` 初始化、切片 `hist[-40:]`） | `engine.py` 常量区、`search()` |
| 字典 dict（计数、缓存两种经典用法） | `search()` 的 `rep_count`、`self.tt` 置换表 |
| 集合 set（O(1) 的"在不在"判断） | `TRAPS` 陷阱、`self._path` 重复路径 |
| 元组 tuple 与解包 `for dc, dr in DIRS` | `gen_moves()` |
| 函数默认参数 / 关键字传参 | `search(..., stale_ply=0, ...)` |
| 类型注解 `list[int]` `-> bool` | 各函数签名（现代 Python 必备技能） |
| `@dataclass` 数据类 | `Move` / `SearchResult` |
| 类 class、`self`、实例属性 | `JungleEngine` 整个类 |
| `__name__ == "__main__"` 惯用法 | `selfplay.py` / `human_play.py` 末尾 |
| argparse 命令行参数 | `selfplay.py` 的 `main()` |
| try / except 异常处理 | `human_play.py` 的输入循环 |
| 时间控制 `time.perf_counter()` | `search()` 与 `_time_up()` |
| 位运算小技巧 `nodes & 511` | `_time_up()`（等价于每隔 512 查一次表） |

## 算法原理速览（配合 engine.py 注释读）

- **negamax**：极大极小搜索的简化形式。"我走一步后，我的得分 = 负的对方最佳得分"。
  双方轮流做选择，形成一棵博弈树；引擎在树上找对自己最有利的路线。
- **α-β 剪枝**：搜索中维护两个界（alpha=我方能保证的下限，beta=对方允许的上限），
  一旦某条分支确定不会被对方采纳，立即放弃搜索这条分支——结果不变，速度大增。
- **静态搜索（quiescence）**：深度用尽时不马上评估，而是把"吃子交换链"走完再评估，
  否则引擎看不到"刚吃子会被反吃"。
- **置换表**：不同走法顺序常到达同一局面；把算过的局面存进字典，再遇到直接查表。
- **防死局三件套**（对应近期对 JS 版的改进）：
  搜索路径重复检测（树内不走回头路）、根节点重复扣分（重复次数越多罚越狠，
  领先方翻倍）、无吃子紧迫感（僵持时催领先方进攻）。

## Python 版 vs JS 版的性能说明

同一时间预算下 Python 版搜索深度约 4~6 层，JS 版约 8~10 层。
原因：CPython 解释执行比 JS 的 JIT 慢约 20~50 倍（每个节点要创建更多对象）。
这是语言特性而非代码问题。真实项目想提速可以：换 PyPy 运行、用 numpy 向量化、
或把热循环移植到 C 扩展——这也是很好的进阶学习课题。

## License

MIT
