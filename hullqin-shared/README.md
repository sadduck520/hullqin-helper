# hullqin-shared · game.hullqin.cn 助手脚本公共模块

几个游戏助手（国际象棋 / 斗兽棋 / 五子棋 / 斗地主）共用的运行时模块与打包库。
所有模块挂在一个全局命名空间 `HQ` 下，脚本之间互不干扰。

## 运行时模块（打包进每个 user.js）

| 文件 | 提供的 API | 说明 |
|---|---|---|
| `fiber-utils.js` | `HQ.getFiber(el)` / `HQ.findProps(el, test, maxHop)` | 读取 React 组件 fiber 上的 memoizedProps（游戏状态都在这） |
| `page-utils.js` | `HQ.clickEl` / `HQ.sleep` / `HQ.toast` | 模拟点击、等待、顶部提示浮层 |
| `overlay.js` | `HQ.createOverlay(svg, viewBox)` / `HQ.clearOverlay` / `HQ.removeOverlay` | 棋盘高亮覆盖层（fixed 定位、scroll/resize 自贴合） |
| `panel.js` | `HQ.loadSettings` / `HQ.saveSettings` / `HQ.makeDraggable` | localStorage 设置存取、面板拖动 |

引擎文件不走 HQ：各游戏引擎用自包含 UMD 包装（`(function(root, factory){...})(this, factory)`，浏览器挂全局名、Node 走 module.exports），与 `hullqin斗兽棋/engine.core.js` 的模式一致。

## 打包库

`build-lib.js` 提供 `buildUserScript({ name, namespace, version, description, connects, modules, body, outFile })`。
各游戏的 `build.js` 只需声明自己的模块清单。

## 新增一个游戏助手的步骤

1. 建目录 `<游戏>/`，写 `engine.core.js`（自包含 UMD 包装：浏览器挂全局名、Node 走 module.exports，保证可测）
2. 写 `userscript.body.js`：用 `HQ.findProps` 读状态、`HQ.clickEl` 执行走法、`HQ.createOverlay` 画提示、`HQ.loadSettings/makeDraggable` 建面板；建议加路由门禁（如 `if (!/\/wzq/.test(location.pathname)) return;`）避免面板叠加
3. 写 `build.js` 调用 `buildUserScript`，输出 `xxx.user.js`，装进 Tampermonkey

## 交互模式约定（与现有脚本一致）

- 主循环 `setInterval(tick, 400~450ms)` + `busy` 锁；只读页面、计算走法、模拟点击，不拦截网络
- 联机时只有己方回合页面才给 DOM `onclick`，以此判断真实可点性（fiber 的 onClick 联机下不可靠）
- 自动走子前加 `sleep(500 + Math.random()*1000)` 拟人延迟
