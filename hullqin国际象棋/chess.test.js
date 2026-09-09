// 国际象棋引擎自测：perft 标准测试集 + 规则用例 + 自博弈
const E = require('./chess.core.js');
let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
}

console.log('== 1. perft 初始局面 ==');
{
  const s = E.fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  eq('perft(1)=20', E.perft(s, 1), 20);
  eq('perft(2)=400', E.perft(s, 2), 400);
  eq('perft(3)=8902', E.perft(s, 3), 8902);
  eq('perft(4)=197281', E.perft(s, 4), 197281);
}

console.log('== 2. perft Kiwipete（易位/闪击密集局面） ==');
{
  const s = E.fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  eq('perft(1)=48', E.perft(s, 1), 48);
  eq('perft(2)=2039', E.perft(s, 2), 2039);
  eq('perft(3)=97862', E.perft(s, 3), 97862);
}

console.log('== 3. perft 位置3（吃过路兵/牵制） ==');
{
  const s = E.fromFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  eq('perft(1)=14', E.perft(s, 1), 14);
  eq('perft(2)=191', E.perft(s, 2), 191);
  eq('perft(3)=2812', E.perft(s, 3), 2812);
  eq('perft(4)=43238', E.perft(s, 4), 43238);
}

console.log('== 4. perft 位置4（升变） ==');
{
  const s = E.fromFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  eq('perft(1)=6', E.perft(s, 1), 6);
  eq('perft(2)=264', E.perft(s, 2), 264);
  eq('perft(3)=9467', E.perft(s, 3), 9467);
}

console.log('== 5. perft 位置5 ==');
{
  const s = E.fromFEN('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
  eq('perft(1)=44', E.perft(s, 1), 44);
  eq('perft(2)=1486', E.perft(s, 2), 1486);
  eq('perft(3)=62379', E.perft(s, 3), 62379);
}

console.log('== 6. 规则细节用例 ==');
{
  // 王车易位：f3 黑车攻击 f1 → 短易位（穿 f1）非法，长易位（穿 d1c1）合法
  let s = E.fromFEN('4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1');
  let moves = E.genLegal(s).filter(m => m.flag === 'ck' || m.flag === 'cq');
  eq('王穿过被攻击格时短易位非法', moves.some(m => m.flag === 'ck'), false);
  eq('长易位仍可用', moves.some(m => m.flag === 'cq'), true);
  // 易位权被车移动消除
  s = E.fromFEN('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const rookMove = E.genLegal(s).find(m => m.from === 56 && m.to === 24); // a1-a4? pos24=a4? y3*8+0=24
  const sv = E.makeMove(s, rookMove);
  const s2 = E.toFEN(s);
  E.unmakeMove(s, rookMove, sv);
  eq('白车移动后失去长易位权', s2.includes('Q'), false);
  eq('unmake 恢复易位权', E.toFEN(s).includes('Q'), true);
  // 吃过路兵（d5 黑兵，e5 白兵，ep=d6=pos19；被吃黑兵在 d5=pos28）
  s = E.fromFEN('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const ep = E.genLegal(s).find(m => m.flag === 'ep');
  eq('吃过路兵生成', !!ep, true);
  if (ep) {
    eq('吃过路兵目标为d6', ep.to, 19);
    const sv2 = E.makeMove(s, ep);
    eq('被吃黑兵消失(d5=pos27)', s.board[27], 0);
    eq('吃过路兵落点正确(d6白兵)', s.board[19], 1);
    E.unmakeMove(s, ep, sv2);
    eq('unmake 恢复黑兵(d5=pos27)', s.board[27], 9);
    eq('unmake 后 FEN 复原', E.toFEN(s), '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  }
  // 升变（白兵a7=pos8 → a8=pos0）
  s = E.fromFEN('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  moves = E.genLegal(s).filter(m => m.promo);
  eq('升变生成4种', moves.length, 4);
  const promoQ = moves.find(m => m.promo === 5);
  const sv3 = E.makeMove(s, promoQ);
  eq('升变后a8为白后', s.board[0], 5);
  E.unmakeMove(s, promoQ, sv3);
  eq('unmake 恢复a7白兵', s.board[8], 1);
  eq('unmake 后 FEN 复原', E.toFEN(s), '4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  // 将死检测
  s = E.fromFEN('R6k/6pp/8/8/8/8/8/K7 b - - 0 1'); // 黑王被将死？8线 a8车+g7h7兵
  eq('将死时无合法走法', E.genLegal(s).length, 0);
}

console.log('== 7. 自博弈 20 局（合法性+终局） ==');
{
  let wins = [0, 0], draws = 0;
  for (let g = 0; g < 20; g++) {
    const s = E.newState();
    E.setupStart(s);
    const hist = [];
    let plies = 0, winner = -1;
    while (plies < 240) {
      const legal = E.genLegal(s);
      if (legal.length === 0) {
        winner = E.inCheck(s, s.whiteTurn) ? (s.whiteTurn ? 1 : 0) : -1; // 被将死：对方胜；逼和：和棋
        break;
      }
      const r = E.search(s, { maxDepth: 3, timeMs: 40, avoid: hist.slice(-12) });
      if (!r.move) { winner = E.inCheck(s, s.whiteTurn) ? (s.whiteTurn ? 1 : 0) : -1; break; }
      const key = E.posKeyFull(s);
      // 验证走法合法
      const mv = legal.find(m => m.from === r.move.from && m.to === r.move.to && m.promo === r.move.promo);
      if (!mv) throw new Error(`第${g}局引擎返回非法走法`);
      E.makeMove(s, r.move);
      hist.push(E.posKeyFull(s));
      plies++;
    }
    if (plies >= 240) draws++;
    else if (winner >= 0) wins[winner]++;
    else draws++;
  }
  console.log(`    20局完成：白胜${wins[0]} 黑胜${wins[1]} 和${draws}`);
  pass++;
}

console.log('== 8. 搜索性能与杀棋发现 ==');
{
  const s = E.fromFEN('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); // 白车+兵优势
  const r = E.search(s, { maxDepth: 8, timeMs: 600 });
  console.log(`    优势局面：深度${r.depth} ${r.ms}ms ${r.nodes}节点，评估 ${(r.score / 100).toFixed(1)}`);
  eq('优势局评估>3.0', r.score > 300, true);
  // 一将杀局面：白一歩杀
  const s2 = E.fromFEN('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); // Ra8#? a1车到a8，黑王g8挡不住？h7g7f7兵堵住，Ra8#
  const r2 = E.search(s2, { maxDepth: 3, timeMs: 1000 });
  eq('发现一步杀 Ra8', r2.move && r2.move.from === 56 && r2.move.to === 0, true);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
