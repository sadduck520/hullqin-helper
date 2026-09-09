// 拼装五子棋 AI 油猴脚本：公共模块（hullqin-shared）+ 引擎 + 桥接/UI
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');

buildUserScript({
  name: '五子棋 AI 助手（game.hullqin.cn）',
  namespace: 'wzq-ai-helper',
  version: '1.2.1',
  description: '桌游合集五子棋的 AI 助手：💡提示（高亮最佳落点）与 🤖自动落子，negamax + αβ + 置换表引擎，支持全部 8 种规则（含禁手判定：三三/四四/长连）。朋友间娱乐使用。',
  modules: [path.join(__dirname, 'wzq.core.js')],
  body: path.join(__dirname, 'userscript.body.js'),
  epilogue: 'HQ.mountStandalone();',
  outFile: path.join(__dirname, '五子棋AI助手.user.js'),
});
