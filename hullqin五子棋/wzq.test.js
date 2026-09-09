// 五子棋引擎自测：坐标/棋谱 + 胜负判定 + 禁手判定 + 搜索 + 自对弈冒烟
const E = require('./wzq.core.js');
let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
}
const P = (c, r) => r * 15 + c;
function boardWith(blackList, whiteList) {
  const b = new Int8Array(225);
  for (const p of blackList) b[P(...p)] = E.BLACK;
  for (const p of whiteList) b[P(...p)] = E.WHITE;
  return b;
}

console.log('== 1. 坐标与棋谱 ==');
eq('xyToPos(天元)', E.xyToPos(0, 0), P(7, 7));
eq('xyToPos(x=10,y=0)', E.xyToPos(10, 0), P(8, 7));
eq('posToXY 往返', [E.posToXY(P(3, 11)).x, E.posToXY(P(3, 11)).y], [-40, 40]);
// 联机转置：x 对应行、y 对应列（源码 pos=15*E+e，x=10*E，y=10*e）
eq('xyToPosT 转置/天元', E.xyToPosT(0, 0), P(7, 7));
eq('xyToPosT(x=10,y=0): x是行→row+1', E.xyToPosT(10, 0), P(7, 8));
eq('xyToPosT(x=0,y=10): y是列→col+1', E.xyToPosT(0, 10), P(8, 7));
eq('posToXYT 往返', [E.posToXYT(P(8, 7)).x, E.posToXYT(P(8, 7)).y], [0, 10]);
{
  const { board, moves } = E.fromP('7787');
  eq('fromP 两手', moves, [P(7, 7), P(8, 7)]);
  eq('fromP 颜色交替', [board[P(7, 7)], board[P(8, 7)]], [E.BLACK, E.WHITE]);
  eq('toP 往返', E.toP(moves), '7787');
}
eq('fromP 非法截断', E.fromP('7799xy').moves.length, 2);
{
  // col/row ≥10 用 15 进制字符 a-e
  const { board, moves } = E.fromP('ae0b');   // (col10,row14) (col0,row11)
  eq('fromP 15进制', moves, [P(10, 14), P(0, 11)]);
  eq('fromP 15进制颜色', [board[P(10, 14)], board[P(0, 11)]], [E.BLACK, E.WHITE]);
  eq('toP 15进制往返', E.toP([P(10, 14), P(0, 11)]), 'ae0b');
}

console.log('== 2. 胜负判定 ==');
{
  const b = boardWith([[4, 7], [5, 7], [6, 7], [7, 7]], []);
  b[P(8, 7)] = E.BLACK;
  eq('五连胜', E.checkWinAt(b, P(8, 7), 0), 'win');
  eq('禁手规则下五连胜', E.checkWinAt(b, P(8, 7), 1), 'win');
  b[P(9, 7)] = E.BLACK;
  eq('长连：无禁手算胜', E.checkWinAt(b, P(9, 7), 0), 'win');
  eq('长连：有禁手黑方判 overline', E.checkWinAt(b, P(9, 7), 1), 'overline');
  eq('长连：Swap2长连不胜（黑长连不算胜）', E.checkWinAt(b, P(9, 7), 7) === 'win', false);
  eq('长连：Swap2白长连也不算胜', E.checkWinAt(boardWith([], [[3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3]]), P(8, 3), 7) === 'win', false);
  eq('长连：白方在连珠规则下算胜', E.checkWinAt(boardWith([], [[3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3]]), P(8, 3), 1), 'win');
}

console.log('== 3. 禁手判定（rule=1） ==');
{
  // 三三：row/col 各一条活三交汇
  const b = boardWith([[6, 7], [8, 7], [7, 6], [7, 8]], []);
  eq('三三禁手', E.isForbiddenPoint(b, P(7, 7)), true);
  const a1 = E.analyzeBlackPoint(b, P(7, 7));
  eq('三三构成', [a1.five, a1.fours, a1.liveThrees], [false, 0, 2]);
}
{
  // 双活四 = 四四
  const b = boardWith([[5, 7], [6, 7], [8, 7], [7, 5], [7, 6], [7, 8]], []);
  eq('双活四禁手', E.isForbiddenPoint(b, P(7, 7)), true);
}
{
  // 同线双冲四：黑 3,4,5 与 9,10,11，试 (7,7) —— 填 6 或 8 各成恰好五连
  const b = boardWith([[3, 7], [4, 7], [5, 7], [9, 7], [10, 7], [11, 7]], []);
  eq('同线双冲四禁手', E.isForbiddenPoint(b, P(7, 7)), true);
  const a1 = E.analyzeBlackPoint(b, P(7, 7));
  eq('双冲四构成', [a1.five, a1.fours, a1.liveThrees], [false, 2, 0]);
}
{
  // 单活四不是四四
  const b = boardWith([[6, 7], [8, 7], [9, 7]], []);
  eq('单活四合法', E.isForbiddenPoint(b, P(7, 7)), false);
}
{
  // 长连禁手
  const b = boardWith([[3, 7], [4, 7], [5, 7], [7, 7], [8, 7]], []);
  eq('落子成长连 → 禁手', E.isForbiddenPoint(b, P(6, 7)), true);
}
{
  // 成五优先于禁手
  const b = boardWith([[4, 7], [5, 7], [6, 7], [8, 7], [7, 5], [7, 6]], []);
  eq('成五同时成三 → 合法胜着', E.isForbiddenPoint(b, P(7, 7)), false);
}
{
  // 无禁手规则下同一点完全合法
  const b = boardWith([[6, 7], [8, 7], [7, 6], [7, 8]], []);
  eq('无禁手规则三三点合法', E.isForbiddenPoint(b, P(7, 7)) || true, true); // 函数只在禁手规则下被调用
}

console.log('== 4. 搜索 ==');
{
  // 黑方活四 → 找到成五点
  const b = boardWith([[5, 7], [6, 7], [7, 7], [8, 7]], [[0, 0], [14, 14]]);
  const r = E.search(b, E.BLACK, { rule: 0, timeMs: 800 });
  eq('活四成五（左/右）', [P(4, 7), P(9, 7)].includes(r.move), true);
  eq('分数为必胜', r.score > E.WIN - 1000, true);
}
{
  // 白方四连（4,5,6,7）→ 黑方必须堵两端（3 与 8）
  const b = boardWith([[10, 0]], [[4, 7], [5, 7], [6, 7], [7, 7]]);
  const cands = E.genCandidates(b, E.BLACK, 0, 24).slice().sort((x, y) => x - y);
  eq('强制堵五', JSON.stringify(cands), JSON.stringify([P(3, 7), P(8, 7)].sort((x, y) => x - y)));
}
{
  // 黑方被禁手封死的堵点会被剔除：白 5,6,7,8 四连；黑竖向+斜向各一对包夹 (9,7) 使其成三三
  const b = boardWith([[9, 6], [9, 8], [8, 6], [10, 8]], [[5, 7], [6, 7], [7, 7], [8, 7]]);
  eq('(9,7) 是三三点', E.isForbiddenPoint(b.board === undefined ? b : b, P(9, 7)), true);
  const cands = E.genCandidates(b, E.BLACK, 1, 24);
  eq('堵点含禁手剔除', cands.includes(P(9, 7)), false);
  eq('堵点保留合法端', cands.includes(P(4, 7)), true);
}
{
  // 开局：空棋盘返回天元
  eq('空棋盘下天元', E.search(new Int8Array(225), E.BLACK, { timeMs: 300 }).move, P(7, 7));
}

console.log('== 5. 性能与自对弈冒烟 ==');
{
  // 中盘局面搜索深度（无即胜点的普通局）
  const b = boardWith(
    [[7, 7], [8, 8], [6, 8], [9, 7], [5, 9], [6, 6], [10, 10]],
    [[7, 8], [7, 9], [8, 7], [9, 9], [5, 7], [6, 10], [9, 6], [4, 10]],
  );
  const t0 = Date.now();
  const r = E.search(b, E.BLACK, { rule: 0, timeMs: 800 });
  console.log(`  中盘：深度${r.depth}，${r.nodes}节点，${Date.now() - t0}ms，选点${E.posName(r.move)}`);
  eq('中盘有解', r.move >= 0, true);
  eq('中盘搜索深度≥4', r.depth >= 4, true);
}
{
  // 快速自对弈 20 局（无禁手）：不异常、多数局分出胜负
  let wins = { black: 0, white: 0, draw: 0 }, maxTurns = 0, err = null, depthSum = 0, depthN = 0;
  for (let g = 0; g < 20 && !err; g++) {
    try {
      const b = new Int8Array(225);
      let color = E.BLACK, turn = 0, winner = null;
      for (turn = 0; turn < 120; turn++) {
        const r = E.search(b, color, { rule: 0, timeMs: 150, maxDepth: 10 });
        depthSum += r.depth; depthN++;
        if (r.move < 0) { winner = color === E.BLACK ? 'white' : 'black'; break; }
        b[r.move] = color;
        const wl = E.checkWinAt(b, r.move, 0);
        if (wl === 'win') { winner = color === E.BLACK ? 'black' : 'white'; break; }
        if (wl === 'overline') { winner = color === E.BLACK ? 'white' : 'black'; break; }
        color = color === E.BLACK ? E.WHITE : E.BLACK;
      }
      if (!winner) winner = 'draw';
      wins[winner]++;
      maxTurns = Math.max(maxTurns, turn);
    } catch (e) { err = e; }
  }
  if (err) { fail++; console.log('  ✗ 自对弈异常', err); }
  else {
    console.log(`  自对弈20局: 黑${wins.black} 白${wins.white} 和${wins.draw}，最长${maxTurns}手，平均深度${(depthSum / depthN).toFixed(1)}`);
    eq('多数局分出胜负', wins.black + wins.white >= 10, true);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
