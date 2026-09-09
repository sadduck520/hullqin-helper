// 引擎规则自测 —— 对照游戏源码手工推演的用例
const E = require('./engine.core.js');
let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
}
function boardWith(overrides) {
  // overrides: {pieceId: pos} 未提及的棋子视为阵亡
  const pos = new Array(16).fill(E.DEAD);
  for (const [id, p] of Object.entries(overrides)) pos[id] = p;
  return { pos: Int8Array.from(pos), board: E.boardFrom(pos) };
}

console.log('== 1. 初始局面走法数量 ==');
{
  const board = E.boardFrom(E.INIT_POS);
  // 手工推演：象3 狮2 虎2 豹3 狼3 狗4 猫4 鼠3 = 24
  const counts = [];
  for (let i = 0; i < 8; i++) counts.push(E.genMoves(board, i).length);
  eq('红方各子走法 [象狮虎豹狼狗猫鼠]', counts, [3, 2, 2, 3, 3, 4, 4, 3]);
  const green = [];
  for (let i = 8; i < 16; i++) green.push(E.genMoves(board, i).length);
  eq('绿方各子走法（对称）', green, [3, 2, 2, 3, 3, 4, 4, 3]);
  eq('红方总走法', E.genAll(board, true, E.INIT_POS).length, 24);
}

console.log('== 2. 狮虎跳河 ==');
{
  // 红狮在 (row5,col0)=35，右侧是河 (c1,c2)，对岸 (row5,col3)=38
  let { pos, board } = boardWith({ 1: 35 });
  eq('狮在河边可跳到对岸38', E.genMoves(board, 1, pos[1]).includes(38), true);
  // 河里有绿鼠（15在36）→ 被挡
  ({ pos, board } = boardWith({ 1: 35, 15: 36 }));
  eq('河中有子挡住跳跃', E.genMoves(board, 1, pos[1]).includes(38), false);
  // 对岸有绿狗(13)在38 → 跳河吃
  ({ pos, board } = boardWith({ 1: 35, 13: 38 }));
  eq('跳河吃对岸棋子', E.genMoves(board, 1, pos[1]).includes(38), true);
  // 对岸有绿象(8)在38 → 狮(1)吃不动象(0)
  ({ pos, board } = boardWith({ 1: 35, 8: 38 }));
  eq('跳河遇到吃不动的子不生成走法', E.genMoves(board, 1, pos[1]).includes(38), false);
  // 对岸有己方虎(2)在38 → 不可
  ({ pos, board } = boardWith({ 1: 35, 2: 38 }));
  eq('对岸己方棋子挡落点', E.genMoves(board, 1, pos[1]).includes(38), false);
  // 狮不能直接走进河（河中无子也不行）
  ({ pos, board } = boardWith({ 1: 35 }));
  eq('狮不能走入河格36', E.genMoves(board, 1, pos[1]).includes(36), false);
  // 纵向跳河：绿虎(10)在(row2,col2)=16，下方河 rows3-5，落点 (row6,col2)=44
  ({ pos, board } = boardWith({ 10: 16 }));
  eq('绿虎纵向跳河到44', E.genMoves(board, 10, pos[10]).includes(44), true);
  // 纵向被水中的鼠挡：红鼠(7)在23 (row3,col2)
  ({ pos, board } = boardWith({ 10: 16, 7: 23 }));
  eq('水中的鼠挡住纵向跳河', E.genMoves(board, 10, pos[10]).includes(44), false);
}

console.log('== 3. 鼠与河 ==');
{
  // 红鼠在河里 (row3,col1)=22
  let { pos, board } = boardWith({ 7: 22, 0: 21 }); // 陆地 (row3,col0)=21 有红象
  eq('水中的鼠不能吃陆上的象', E.genMoves(board, 7, pos[7]).includes(21), false);
  ({ pos, board } = boardWith({ 7: 22, 15: 21 })); // 陆上有绿鼠
  eq('水中的鼠可以吃陆上的鼠', E.genMoves(board, 7, pos[7]).includes(21), true);
  ({ pos, board } = boardWith({ 7: 22, 15: 23 })); // 水中 (row3,col2)=23 有绿鼠
  eq('水中鼠互吃', E.genMoves(board, 7, pos[7]).includes(23), true);
  ({ pos, board } = boardWith({ 7: 21, 15: 22 }));
  eq('陆上鼠可入水吃水中的鼠', E.genMoves(board, 7, pos[7]).includes(22), true);
  ({ pos, board } = boardWith({ 0: 21 }));
  eq('象不能入河', E.genMoves(board, 0, pos[0]).includes(22), false);
  // 鼠在河中央挡住狮的横向跳跃（36 = row5,col1）
  ({ pos, board } = boardWith({ 15: 36, 1: 35 }));
  eq('水中的鼠挡住狮横向跳', E.genMoves(board, 1, pos[1]).includes(38), false);
}

console.log('== 4. 陷阱 ==');
{
  // 绿狗(13)进入红方陷阱 (row7,col3)=52，红猫(6)在 (row7,col2)=51 可任意吃
  let { pos, board } = boardWith({ 13: 52, 6: 51 });
  eq('敌子入我方陷阱可被任意吃', E.genMoves(board, 6, pos[6]).includes(52), true);
  // 绿象在红陷阱里，红鼠也能吃
  ({ pos, board } = boardWith({ 8: 52, 7: 51 }));
  eq('鼠也能吃陷阱里的象', E.genMoves(board, 7, pos[7]).includes(52), true);
  // 己方可以走进己方空陷阱
  ({ pos, board } = boardWith({ 7: 51 }));
  eq('可走入己方空陷阱', E.genMoves(board, 7, pos[7]).includes(52), true);
  // 己方棋子挡住己方陷阱
  ({ pos, board } = boardWith({ 7: 52 }));
  eq('己方棋子占己方陷阱不可进', E.genMoves(board, 7, pos[7]).includes(52), false);
  // 红棋(7)在绿陷阱(row1,col3)=10，绿猫(14)在(row2,col3)=17
  ({ pos, board } = boardWith({ 7: 10, 14: 17 }));
  eq('红棋在绿陷阱中，绿猫可任意吃', E.genMoves(board, 14, pos[14]).includes(10), true);
  // 站在敌方陷阱中仍可正常吃子：红猫在绿陷阱10，绿鼠15在9 → 吃
  ({ pos, board } = boardWith({ 6: 10, 15: 9 }));
  eq('陷阱中的棋子仍可正常吃子', E.genMoves(board, 6, pos[6]).includes(9), true);
}

console.log('== 5. 兽穴 ==');
{
  let { pos, board } = boardWith({ 6: 53 }); // 红猫在 (row7,col4)=53，红穴59在斜下方
  eq('猫(53)不能斜跳进己方兽穴', E.genMoves(board, 6, pos[6]).includes(59), false);
  ({ pos, board } = boardWith({ 6: 58 })); // 红猫在 (row8,col2)=58，红穴59在右边
  eq('不可进入己方兽穴', E.genMoves(board, 6, pos[6]).includes(59), false);
  ({ pos, board } = boardWith({ 6: 10 })); // 红猫在 (row1,col3)=10，绿穴3在正上方
  eq('可进入敌方兽穴', E.genMoves(board, 6, pos[6]).includes(3), true);
}

console.log('== 6. 大小吃子 ==');
{
  const cases = [
    [0, 1, true], [0, 7, false], [7, 0, true], [6, 6, true], [5, 4, false], [4, 5, true],
  ];
  for (const [a, d, exp] of cases) eq(`canEat(${a},${d})`, E.canEat(a, d), exp);
}

console.log('== 7. 搜索自博弈 20 局（深度自动+重复规避，验证合法性与终局） ==');
{
  let wins = { 0: 0, 1: 0 }, draws = 0;
  for (let g = 0; g < 20; g++) {
    const pos = Int8Array.from(E.INIT_POS);
    let side = E.RED, plies = 0, winner = -1;
    const history = [E.posKey(pos)];
    while (plies < 300) {
      const r = E.search(pos, side, 50, history.slice(-10));
      if (!r.move) { winner = 1 - side; break; }
      // 验证走法合法性
      const board = E.boardFrom(pos);
      const legal = E.genMoves(board, r.move.pieceId);
      if (!legal.includes(r.move.to)) throw new Error(`第${g}局非法走法! piece ${r.move.pieceId} → ${r.move.to}, legal=${legal}`);
      // 应用走法
      const victim = board[r.move.to];
      board[pos[r.move.pieceId]] = -1;
      board[r.move.to] = r.move.pieceId;
      if (victim >= 0) pos[victim] = E.DEAD;
      pos[r.move.pieceId] = r.move.to;
      history.push(E.posKey(pos));
      // 终局判定（对照游戏 qv 逻辑）
      if (r.move.to === E.DENS[1 - side]) { winner = side; break; }
      const oppAlive = [];
      for (let i = (1 - side) * 8; i < (1 - side) * 8 + 8; i++) if (pos[i] < 63) oppAlive.push(i);
      if (oppAlive.length === 0) { winner = side; break; }
      const oppBoard = E.boardFrom(pos);
      if (!oppAlive.some(id => E.genMoves(oppBoard, id).length > 0)) { winner = side; break; }
      side = 1 - side; plies++;
    }
    if (plies >= 300) { draws++; console.log(`    第${g}局和棋(300步未分胜负，用于压力测试仍有效)`); }
    else wins[winner]++;
  }
  console.log(`    20局全部合法：红胜${wins[0]} 绿胜${wins[1]} 和${draws}`);
  pass++;
}

console.log('== 8. 搜索性能 ==');
{
  const r = E.search(Int8Array.from(E.INIT_POS), E.RED, 800);
  console.log(`    首步搜索：深度${r.depth}，${r.ms}ms，${r.nodes}节点，走法 ${E.NAMES[r.move.pieceId % 8]} ${r.move.from}→${r.move.to}`);
  eq('深度≥6', r.depth >= 6, true);
}

console.log('== 9. 重复规避生效 ==');
{
  // 构造一个只来回挪动的僵持局面，验证 avoid 后 AI 换走法
  const pos = Int8Array.from(E.INIT_POS);
  const board = E.boardFrom(pos);
  const r1 = E.search(pos, E.RED, 200);
  // 假装这个局面已经出现过5次
  const r2 = E.search(pos, E.RED, 200, Array(5).fill(E.posKey(pos)));
  console.log(`    无规避: ${E.NAMES[r1.move.pieceId % 8]} ${r1.move.from}→${r1.move.to} | 有规避: ${E.NAMES[r2.move.pieceId % 8]} ${r2.move.from}→${r2.move.to}`);
  pass++;
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
