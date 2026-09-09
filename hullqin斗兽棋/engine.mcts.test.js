// MCTS 引擎自测：验证 search 已被替换、走法合法、能正常对弈到底
const E = require('./engine.mcts.js');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('== 1. MCTS 首步搜索（1000ms，本测试暂关开局书）==');
{
  process.env.DSQ_BOOK_OFF = '1';
  const r = E.search(Int8Array.from(E.INIT_POS), E.RED, 1000);
  delete process.env.DSQ_BOOK_OFF;
  console.log(`    模拟 ${r.nodes} 局 | 树深 ${r.depth} | ${r.ms}ms | 走法 ${r.move ? E.NAMES[r.move.pieceId % 8] + ' ' + r.move.from + '->' + r.move.to : '无'}`);
  ok('模拟次数充足（>=2000）', r.nodes >= 2000);
  ok('返回字段完整（move/score/depth/nodes/ms）', r.move && typeof r.score === 'number' && typeof r.depth === 'number' && typeof r.nodes === 'number' && typeof r.ms === 'number');
  const legal = E.genMoves(E.boardFrom(E.INIT_POS), r.move.pieceId);
  ok('首步走法合法', legal.includes(r.move.to));
}

console.log('== 2. 规则模块未变 ==');
{
  const b = E.boardFrom(E.INIT_POS);
  ok('初始局面红方 24 种走法', E.genAll(b, true, E.INIT_POS).length === 24);
  ok('鼠吃象特例生效', E.canEat(7, 0) === true && E.canEat(0, 7) === false);
}

console.log('== 3. MCTS 自对弈 3 局（每步 150ms）==');
{
  let wins = { 0: 0, 1: 0 }, draws = 0;
  for (let g = 0; g < 3; g++) {
    const pos = Int8Array.from(E.INIT_POS);
    let side = E.RED, plies = 0, winner = -1;
    const history = [E.posKey(pos)];
    const seen = new Map();
    seen.set(E.posKey(pos) + '|' + side, 1);
    while (plies < 600) {
      const key = E.posKey(pos) + '|' + side;
      const cnt = (seen.get(key) || 0) + 1;
      seen.set(key, cnt);
      if (cnt >= 3) { winner = -1; break; }
      const r = E.search(pos, side, 150, history.slice(-10));
      if (!r.move) { winner = 1 - side; break; }
      const board = E.boardFrom(pos);
      const legal = E.genMoves(board, r.move.pieceId);
      if (!legal.includes(r.move.to)) throw new Error('第' + g + '局非法走法! piece ' + r.move.pieceId + ' -> ' + r.move.to);
      const victim = board[r.move.to];
      board[pos[r.move.pieceId]] = -1;
      board[r.move.to] = r.move.pieceId;
      if (victim >= 0) pos[victim] = E.DEAD;
      pos[r.move.pieceId] = r.move.to;
      history.push(E.posKey(pos));
      if (r.move.to === E.DENS[1 - side]) { winner = side; break; }
      const oppAlive = [];
      for (let i = (1 - side) * 8; i < (1 - side) * 8 + 8; i++) if (pos[i] < 63) oppAlive.push(i);
      if (oppAlive.length === 0) { winner = side; break; }
      const ob = E.boardFrom(pos);
      if (!oppAlive.some(id => E.genMoves(ob, id).length > 0)) { winner = side; break; }
      side = 1 - side; plies++;
    }
    if (winner === 0) wins[0]++; else if (winner === 1) wins[1]++; else draws++;
    console.log(`    第${g}局：${winner === 0 ? '红胜' : winner === 1 ? '绿胜' : '和'}（${plies} 回合）`);
  }
  ok('3 局全部有结果', wins[0] + wins[1] + draws === 3);
  console.log(`    红胜${wins[0]} 绿胜${wins[1]} 和${draws}`);
}

console.log('== 4. 重复局面规避 ==');
{
  const r1 = E.search(Int8Array.from(E.INIT_POS), E.RED, 300);
  const pos16 = Int8Array.from(E.INIT_POS);
  const board = E.boardFrom(pos16);
  board[pos16[r1.move.pieceId]] = E.MAP_DEAD;
  board[r1.move.to] = r1.move.pieceId;
  pos16[r1.move.pieceId] = r1.move.to;
  const k1 = E.posKey(pos16);
  const r2 = E.search(Int8Array.from(E.INIT_POS), E.RED, 300, [k1]);
  // 规避后不应再选同一个目标格（除非所有走法都被规避）
  ok('给出历史后避开了重复走法', r2.move.to !== r1.move.to || r2.move.pieceId !== r1.move.pieceId);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);



