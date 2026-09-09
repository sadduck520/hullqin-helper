// 拼装国际象棋 AI 油猴脚本：公共模块（hullqin-shared）+ SFLoader + 引擎 + 桥接/UI
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');

buildUserScript({
  name: '国际象棋 AI 助手（game.hullqin.cn）',
  namespace: 'gjx-ai-helper',
  version: '1.0.2',
  description: '桌游合集国际象棋的 AI 助手：双引擎（Stockfish 世界级 / 自研轻量）+ 1~10 难度可调 + 💡提示 + 🤖自动代走 + 评估条。朋友间娱乐使用。',
  connects: ['cdn.jsdelivr.net'],
  modules: [path.join(__dirname, 'sf.loader.js'), path.join(__dirname, 'chess.core.js')],
  body: path.join(__dirname, 'userscript.body.js'),
  epilogue: 'HQ.mountStandalone();',
  outFile: path.join(__dirname, '国际象棋AI助手.user.js'),
});
