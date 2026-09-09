// HullQin 游戏助手（整合版）：公共模块 + 五个游戏引擎 + 五个桥接 + 统一 GUI 壳
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');

const ROOT = path.join(__dirname, '..');
const g = p => path.join(ROOT, p);

buildUserScript({
  name: 'HullQin 游戏助手（整合版）',
  namespace: 'hq-ai-all-in-one',
  version: '2.0.0',
  description: '桌游合集全游戏 AI 助手整合版：🐘斗兽棋 ♞国际象棋 ⚫五子棋 🃏斗地主 🎯跳棋——按页面自动切换，一套面板。各自功能与独立版一致（提示/托管/记牌器/评估条等）。朋友间娱乐使用。',
  connects: ['cdn.jsdelivr.net'],
  modules: [
    g('hullqin斗兽棋/engine.core.js'),
    g('hullqin国际象棋/sf.loader.js'),
    g('hullqin国际象棋/chess.core.js'),
    g('hullqin五子棋/wzq.core.js'),
    g('hullqin斗地主/ddz.core.js'),
    g('hullqin跳棋/tq.core.js'),
    g('hullqin斗兽棋/userscript.body.js'),
    g('hullqin国际象棋/userscript.body.js'),
    g('hullqin五子棋/userscript.body.js'),
    g('hullqin斗地主/userscript.body.js'),
    g('hullqin跳棋/userscript.body.js'),
  ],
  body: path.join(__dirname, 'shell.js'),
  outFile: path.join(__dirname, 'HullQin游戏助手.user.js'),
});
