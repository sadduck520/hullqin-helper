// 拼装最终油猴脚本：公共模块（hullqin-shared）+ 规则引擎（默认 negamax 增强版）+ 页面桥接/UI
// 默认打包优化后的 negamax（静态搜索+置换表+MVV-LVA+可调深度）；加 --mcts 参数则打包 MCTS 版（已弃用）
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');
const useMcts = process.argv.includes('--mcts');

buildUserScript({
  name: '斗兽棋 AI 助手（game.hullqin.cn）',
  namespace: 'dsq-ai-helper',
  version: '1.3.2',
  description: '桌游合集斗兽棋的 AI 助手：💡提示（高亮最佳走法）与 🤖自动代走，内置 negamax + αβ 剪枝 + 静态搜索 + 置换表引擎，支持可调思考深度与思考时间；规则 1:1 逆向自游戏源码。朋友间娱乐使用。',
  modules: useMcts
    ? [path.join(__dirname, 'engine.core.js'), path.join(__dirname, 'engine.mcts.js')]
    : [path.join(__dirname, 'engine.core.js')],
  body: path.join(__dirname, 'userscript.body.js'),
  epilogue: 'HQ.mountStandalone();',
  outFile: path.join(__dirname, '斗兽棋AI助手.user.js'),
});
