# HullQin 游戏助手

[game.hullqin.cn（桌游合集）](https://game.hullqin.cn) 的五个油猴 AI 助手 + 整合版。
所有助手只读取页面状态、模拟点击，不拦截网络——服务器视角等同正常人类操作。朋友间娱乐使用。

## 助手一览

| 目录 | 游戏 | 功能亮点 | 引擎 |
|---|---|---|---|
| `hullqin斗兽棋` | [斗兽棋 /dsq](https://game.hullqin.cn/dsq) | 💡提示 / 🤖代走；防死局三层机制 | negamax + 静态搜索 + 置换表（规则 1:1 逆向站点源码） |
| `hullqin国际象棋` | [国际象棋 /gjxq](https://game.hullqin.cn/gjxq) | 双引擎 + 1-10 难度 + 评估条 | Stockfish WASM（CDN）/ 自研 negamax |
| `hullqin五子棋` | [五子棋 /wzq](https://game.hullqin.cn/wzq) | 💡提示 / 🤖代走；思考深度 1-10 层 | negamax + 完整禁手判定（8 种规则全支持） |
| `hullqin斗地主` | [斗地主 /ddz](https://game.hullqin.cn/ddz) | 📋记牌器 / 💡出牌提示 / 🤖托管（含叫抢地主） | 牌型判定 1:1 复刻站点 + 启发式决策 |
| `hullqin跳棋` | [跳棋 /tq](https://game.hullqin.cn/tq) | 💡提示 / 🤖托管；2-6 人全布局 | negamax + 梯队评估 + 防死循环 |
| `hullqin-all` | **全部** | **整合版**：一个文件，按页面自动切换，统一 GUI | — |

## 使用

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 安装想要的脚本（各目录的 `*.user.js`，或整合版 `hullqin-all/HullQin游戏助手.user.js`）
3. 打开对应游戏页面，面板自动出现；进入本地对战或联机开局即可使用

## 开发

```bash
cd hullqin五子棋 && node build.js   # 构建单个脚本
node xxx.test.js                    # 各目录内置引擎测试（共 195 项）
```

- `hullqin-shared/` 公共模块：React fiber 状态读取、面板、覆盖层、构建库、注册壳
- 各游戏目录的 `*.core.js` 引擎不依赖 DOM，可在 Node 中测试（`node xxx.test.js`）
- 页面逆向结论写在各目录 README（ fiber props 结构、状态编码、交互方式）

## 测试结论摘要

- 斗兽棋：新旧引擎 A/B 新引擎 74% 胜率；500 局自对弈无显著先后手优势（详见其 README）
- 跳棋：搜索 75% 胜贪心基线，对局 100% 收敛
- 斗地主：52 项测试全过，真实联机局全流程验证

## License

MIT
