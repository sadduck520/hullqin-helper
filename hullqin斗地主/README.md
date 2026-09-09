# hullqin斗地主 · 斗地主 AI 助手（game.hullqin.cn）

油猴脚本，为 [桌游合集](https://game.hullqin.cn/ddz) 的斗地主提供 📋记牌器 + 💡出牌提示 + 🤖托管（自动叫/抢地主、自动出牌、自动过牌）。

## 构建

```bash
node build.js        # 产出 斗地主AI助手.user.js（依赖 ../hullqin-shared）
node ddz.test.js     # 引擎测试（52 项：牌型/压牌/拆牌/决策/记牌器/状态解压）
```

## 真实对局实测结论（v1.0.0，2026-09-08 于房间 hua0）

- 牌局状态在牌局组件 **`props.view`**（`DDZGameData` 解码后**已展开**的对象，含 `playerCardLists`/`lastCards` 等派生字段）
- **`room.position` 是 1 基**座位号（实测 = 2 时 `playerCardLists[2]` 与 DOM 手牌完全一致）；座位组件的 `position` prop 同样 1 基
- **`view.v` 是版本号不是人数**（初始 1 递增）；人数用 `room.playerList.length`
- `state`：0=叫/抢地主阶段（所有人可点按钮），1..n=轮到玩家 n 出牌，9..12=玩家 N 胜
- 操作按钮带 emoji 前缀：`😎 出牌`、`😭 不出` → 匹配用**后缀**正则 `/出牌$/`、`/(?:过|不出|不要)$/`；叫地主阶段为 `叫地主/抢地主/不叫/不抢`
- 手牌 DOM：`div#牌id.ddz-poker`，点击选牌，再点「出牌」确认

## 功能

- **记牌器**：牌样网格（王王2AKQJ10…3 顺序，每格显示点数+剩余张数），0 张置灰，大王红色；统计口径 = 全副牌 − 已出 − 底牌 − 我手
- **叫地主建议**：牌力评分（大王4 小王3 每个2计2 每个A计1 炸弹+3 王炸再+3）与阈值对比展示；2 人局底牌多阈值更低（6），3 人 8，4 人 9
- **💡 提示**：高亮建议出的牌（蓝色描边）
- **🤖 托管**：自动叫/抢（或不叫）、自动领出/压牌/过牌，带拟人延迟；领出先出弱长组合、队友大牌不压、对手报单/报双压制、炸弹时机克制

## 页面逆向结论（ddz chunk 模块 6139 / 5911，静态分析）

- **牌 id**：1-52 为四花色×13（rank 3..14=A、15=2），53=大王、54=小王；4 人掼蛋为 108 张（两副）
- **状态对象**（protobuf `DDZGameData` 解码后展开，挂在联机 UI 组件 props.view 上）：
  `{rule, state, landlordId, cardPositionList, playedCardList, v}` + 派生字段
  - `cardPositionList[i]`（0 基）= 牌 i+1 归属码：低 3 位 = 玩家号（1 基），位 3 = 底牌标记；出牌后 `&=8`
  - `playedCardList`：出牌 push `[0, ...牌id]`，过牌 push `[0]`
  - `state`：0=叫/抢地主阶段，1..n=轮到玩家 n 出牌，9..12=玩家 N 胜（`>8` 即终局，`7&state`=胜者）
  - `v`=状态版本号（初始 1 递增，**不是人数**）；`rule`=1（无规则模式）时 `lastCards` 恒空（可自由出牌）
- **联机组件 props**（`{view, count, position, room, send, isTurn}`）：view=牌局状态；**我的座位 = `room.position`（已是 1 基，勿再 +1）**
- **手牌 DOM**：每张牌 `div#牌id.ddz-poker`（点击选牌）；操作按钮带 emoji 前缀（`😎 出牌`/`😭 不出`），匹配用后缀正则
- **牌型系统**：`Bad/One/Pair/Three/ThreeWithOne/ThreeWithPair/FourWithOnes/FourWithPairs/Four(100)/Jokers(127)`，顺子/连对/飞机长度编码在 type 高位；牌型集参数 = 人数<4（2/3 人有王炸、三带一、四带二；4 人掼蛋无）
- 逻辑排序：张数降序、同张数 rank **升序**（`sortHand` 复刻）
- 状态解压 `expandState`（复刻 g）：玩家手牌/底牌/剩牌数/可否自由出/待压牌 `lastCards`

## 引擎（ddz.core.js）

- 牌型解析与压牌判定 **1:1 复刻**站点逻辑（合法性保证与页面一致）
- 决策为启发式：
  - 叫地主：大牌计分（王/2/A/炸弹）
  - 拆牌：双策略取优（保留炸弹 vs 拆散参与顺子/三带），手数最少
  - 跟牌：最小代价应手；队友大牌不压（农民配合）；对手报单/报双全力压制；炸弹只在手数≤2 或对手≤3 张时使用
  - 领出：先出弱的长组合；对手报单时防单、报双时最小对逼弹
- 记牌器：`remainingRanks`（已出 + 底牌 + 我手 → 场上未现牌，按 rank 统计）

## 排查

真实牌局异常时在控制台执行 `__ddzAI.dump()`：
- `found:false`（附 `pokerEls`/`viewComponents`/`sample`）→ 页面结构变化，按 sample 调整探测
- `found:true` 但 `myPos`/`myHand` 不符 → 发 dump 输出
- 按钮文案变化（新表情/新说法）→ 反馈实际文字

## 测试结论

- 52 项单测全过（含 30 局 3 人随机发牌自对弈：所有出牌均通过合法性校验，平均 39 手结束）
- 真实 2 人联机局（房间 hua0）实测：状态读取、记牌器、叫地主决策、自动领出/跟牌/过牌全流程正常
