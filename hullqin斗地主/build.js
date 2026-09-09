// 拼装斗地主 AI 油猴脚本：公共模块（hullqin-shared）+ 引擎 + 桥接/UI
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');

buildUserScript({
  name: '斗地主 AI 助手（game.hullqin.cn）',
  namespace: 'ddz-ai-helper',
  version: '1.0.0',
  description: '桌游合集斗地主的 AI 助手：📋记牌器 + 💡出牌提示 + 🤖托管出牌（启发式：最少手数拆牌/身份配合/炸弹时机）；牌型判定 1:1 逆向自游戏源码；支持 2/3/4 人。朋友间娱乐使用。',
  modules: [path.join(__dirname, 'ddz.core.js')],
  body: path.join(__dirname, 'userscript.body.js'),
  epilogue: 'HQ.mountStandalone();',
  outFile: path.join(__dirname, '斗地主AI助手.user.js'),
});
