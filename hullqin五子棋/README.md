# hullqin五子棋 · 五子棋 AI 助手（game.hullqin.cn）

油猴脚本，为 [桌游合集](https://game.hullqin.cn/wzq) 的五子棋提供 💡提示 与 🤖自动落子。

## 构建

```bash
node build.js        # 产出 五子棋AI助手.user.js（依赖 ../hullqin-shared）
```

## 测试

```bash
node wzq.test.js         # 引擎单元测试（棋谱解析/胜负/禁手/搜索/自对弈冒烟）
node wzq.selftest.js 40 150   # 三种规则自对弈（局数 每手毫秒）
```

## 架构

| 文件 | 说明 |
|---|---|
| `wzq.core.js` | 引擎：negamax + αβ + 迭代加深 + 置换表 + 静态搜索（成五/堵五强制应手）+ 增量直线评估（棋型打分：活四/冲四/活三/眠三…）+ 完整禁手判定（三三/四四/长连，成五优先），UMD 可 Node 测试 |
| `userscript.body.js` | 页面桥接 + UI 面板（复用 `hullqin-shared` 公共模块） |
| `build.js` | 打包（header + 公共模块 + 引擎 + body） |

## 页面逆向结论（game.hullqin.cn/wzq）

- 棋盘 `svg#svg`，viewBox `-80,-80,160,160`；15 路，交点 (x,y)∈{-70..70} 步长 10
- **落子**：每个空交点一个 `<use xlinkHref="#hover" x y onClick>`，单击直接落子（无需选中）；本地与联机一致
- **本地棋谱**：URL 参数 `p`，每 2 字符一手「列行」，**15 进制**（0-9a-e，如天元 `77`）；规则可经 `rule` 参数恢复
- **联机**（wzq chunk 模块 6278/1323）：牌局组件 props 为 `{isPlayer, view, room, send}`，其中：
  - `view.pieceList`：已落子位置数组（0-224，偶数下标=黑、奇数=白，255 为控制标记）
  - `view.rule`：规则枚举（同本地）；`view.blackId`：黑方座位（0 基）；`view.waitFor`：当前行动座位（0 基）；`view.reqBackBy`：悔棋请求方
  - `phase`（view.state）：0开局 1等交换 2等声明 3等提案 4等选择 **5对局中** 6黑胜 7白胜 8平局 9塔拉分支 10等Swap2
  - 我的座位 = `room.position - 1`（0 基）
  - 联机模式只代走自己：`waitFor === 我的座位` 且行棋颜色吻合时才落子
  - **坐标转置**：联机渲染 `pos=15*row+col` 时 DOM 的 `x=10*row、y=10*col`，与本地（`x=col、y=row`）转置。桥接在联机分支用 `xyToPosT`/`posToXYT`（读 hover、点击落子、高亮全用转置），本地分支保持原函数
- 棋子 DOM：`use #piece` + `fill=url(#black)/url(#white)`（兜底用）
- 开局特殊阶段（phase≠5 非终局）面板提示手动完成，AI 不代做

## 引擎行为要点

- 禁手规则（1/3/4/5/6）下黑方候选全程过滤禁手点；堵点全禁 = 被禁手杀 → 搜索判必败
- Swap2（rule 7）：双方长连皆不算胜；无禁手（0/2）：长连算胜；连珠规则白棋长连算胜
- 被禁手杀时自动「败走」一步合法点（`desperateMove`），让页面走到终局而非卡死
- **难度 = 思考深度（1~10 层）**：左上「深度」滑条控制，思考时间上限 10s（随深度放大 0.5s~10s）；低深度在根节点分差 ≤ cp 的候选里随机（放水让 AI 变弱）

## 自对弈实测（150ms/手）

- 无禁手 40 局：黑 40:0，平均 24 手
- 有禁手 40 局：黑 31:7:2，平均 38 手，**零禁手违规**
- Swap2长连不胜 40 局：黑 40:0，平均 22 手

E2E（浏览器注入）：无禁手/有禁手全程自动对局至终局、URL 15进制棋谱（`a-e`）解析、禁手杀败走、本地模式回归，均验证通过。

## 联机排查

联机若异常，控制台执行 `__wzqAI.diag()`，检查输出：
- `state` 为 null → 未探测到联机组件（确认已在开局后的房间内）
- `state.online` 为 false → 走了本地分支（正常只在本地对战出现）
- `phase` / `myBlack` / `myTurn` 与页面实际不符 → 反馈输出发 issue
