/**
 * hullqin-shared · 油猴脚本打包库
 *
 * 结构约定（每个游戏一个目录）：
 *   <游戏>/engine.core.js        游戏引擎（UMD，可用 HQ.defineEngine）
 *   <游戏>/userscript.body.js    页面桥接 + UI（依赖全局 HQ 命名空间）
 *   <游戏>/build.js              调用本库打包
 *
 * 产出：<游戏>/xxx.user.js = header + 公共模块 + 游戏模块 + body，整体包在一个 IIFE 里。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 打包进所有脚本的公共运行时模块（顺序即依赖顺序：fiber → page → overlay → panel → game-shell）
const SHARED_MODULES = ['fiber-utils.js', 'page-utils.js', 'overlay.js', 'panel.js', 'game-shell.js'];

function readModule(p) {
  return fs.readFileSync(path.isAbsolute(p) ? p : path.join(__dirname, p), 'utf8');
}

/**
 * @param {object} opts
 * @param {string} opts.name        脚本名（如 '斗兽棋 AI 助手（game.hullqin.cn）'）
 * @param {string} opts.namespace   @namespace
 * @param {string} opts.version     @version
 * @param {string} opts.description @description
 * @param {string[]} [opts.connects] 额外 @connect 域（如 CDN）
 * @param {string[]} opts.modules   游戏自有模块文件（相对游戏目录或绝对路径）
 * @param {string} opts.body        body 文件路径
 * @param {string} opts.outFile     输出文件路径
 * @param {string} [opts.epilogue]  追加在末尾的代码（独立版用 `HQ.mountStandalone();`）
 */
function buildUserScript(opts) {
  const header = `// ==UserScript==
// @name         ${opts.name}
// @namespace    ${opts.namespace}
// @version      ${opts.version}
// @description  ${opts.description}
// @author       Eve
// @match        https://game.hullqin.cn/*
// @run-at       document-idle
// @grant        none
${(opts.connects || []).map(c => '// @connect      ' + c + '\n').join('')}// @license      MIT
// ==/UserScript==
`;
  const parts = SHARED_MODULES.map(readModule);
  for (const m of opts.modules) parts.push(readModule(m));
  parts.push(readModule(opts.body));
  if (opts.epilogue) parts.push(opts.epilogue);
  const out = header + '(function () {\n' + parts.join('\n') + '\n})();\n';
  fs.writeFileSync(opts.outFile, out);
  console.log('built:', opts.outFile, out.length, 'bytes');
}

module.exports = { buildUserScript };
