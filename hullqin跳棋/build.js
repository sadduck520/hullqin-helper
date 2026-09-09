// 拼装跳棋 AI 油猴脚本：公共模块（hullqin-shared）+ 引擎 + 桥接/UI
'use strict';
const path = require('path');
const { buildUserScript } = require('../hullqin-shared/build-lib.js');

buildUserScript({
  name: '跳棋 AI 助手（game.hullqin.cn）',
  namespace: 'tq-ai-helper',
  version: '1.0.0',
  description: '桌游合集跳棋（中国跳棋）的 AI 助手：💡提示 + 🤖托管自动走子；negamax/贪心引擎，支持 2~6 人全部阵营布局与超级跳规则变体。朋友间娱乐使用。',
  modules: [path.join(__dirname, 'tq.core.js')],
  body: path.join(__dirname, 'userscript.body.js'),
  epilogue: 'HQ.mountStandalone();',
  outFile: path.join(__dirname, '跳棋AI助手.user.js'),
});
