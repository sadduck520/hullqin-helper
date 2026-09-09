/**
 * 五子棋自对弈测试：验证引擎在不同规则下自洽
 *   node wzq.selftest.js [局数=40] [毫秒=150]
 * 断言：
 *   - 黑方在禁手规则下从不走出禁手点（若被强制堵点全是禁手则判负——记录该情况）
 *   - 每局都正常结束（五连/无棋可走/满盘）
 * 输出：先手/后手胜负统计
 */
'use strict';
const E = require('./wzq.core.js');
const GAMES = +(process.argv[2] || 40);
const TIME = +(process.argv[3] || 150);

function playGame(rule) {
  const b = new Int8Array(225);
  let color = E.BLACK;
  for (let turn = 0; turn < 225; turn++) {
    const r = E.search(b, color, { rule, timeMs: TIME, maxDepth: 10 });
    if (r.move < 0) return { winner: color === E.BLACK ? 'white' : 'black', turns: turn, reason: 'stuck' };
    // 禁手合法性断言
    if (color === E.BLACK && E.isForbiddenRule(rule) && E.isForbiddenPoint(b, r.move)) {
      return { winner: '?', turns: turn, reason: 'FORBIDDEN_MOVE:' + E.posName(r.move) };
    }
    b[r.move] = color;
    const wl = E.checkWinAt(b, r.move, rule);
    if (wl === 'win') return { winner: color === E.BLACK ? 'black' : 'white', turns: turn + 1, reason: 'five' };
    if (wl === 'overline') {
      // rule7：长连不胜，继续下；禁手规则黑长连本应被过滤（到这说明漏了）
      if (E.isForbiddenRule(rule) && color === E.BLACK) return { winner: '?', turns: turn + 1, reason: 'BLACK_OVERLINE' };
    }
    color = color === E.BLACK ? E.WHITE : E.BLACK;
  }
  return { winner: 'draw', turns: 225, reason: 'full' };
}

for (const rule of [0, 1, 7]) {
  const stat = { black: 0, white: 0, draw: 0, bad: [] };
  let turnsSum = 0;
  for (let g = 0; g < GAMES; g++) {
    const r = playGame(rule);
    turnsSum += r.turns;
    if (r.winner === '?') stat.bad.push(r);
    else stat[r.winner]++;
  }
  const name = rule === 0 ? '无禁手' : rule === 1 ? '有禁手' : 'Swap2长连不胜';
  console.log(`规则${rule}(${name}) ${GAMES}局: 黑${stat.black} 白${stat.white} 和${stat.draw} 平均${(turnsSum / GAMES).toFixed(0)}手${stat.bad.length ? ' ⚠异常:' + JSON.stringify(stat.bad.slice(0, 3)) : ' ✓无禁手违规'}`);
}
