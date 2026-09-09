/**
 * 斗兽棋 MCTS 引擎 —— 蒙特卡洛树搜索替代 negamax + αβ 剪枝
 *
 * 规则函数全部复用 engine.core.js（不在本文件重复实现），只替换 search 算法。
 * 接口与 engine.core.js 的 search 完全一致：
 *   search(piecePos16, sideToMove, budgetMs, avoidKeys)
 *   => { move:{pieceId,from,to,victim}, score, depth, nodes, ms }
 * 其中：
 *   nodes = 完成模拟（playout）的次数
 *   depth = 树中探索到的最大深度
 *   score = 胜率映射出的评估值（正 = 调用方有利）
 *
 * 用法：
 *   Node：const E = require('./engine.mcts.js'); E.search(...)
 *   油猴：本文件放在 engine.core.js 之后、userscript.body.js 之前（DSQEngine 换成 MCTS 独立副本）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DSQEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 取核心规则模块：Node 直接 require；浏览器里用 engine.core.js 暴露的 DSQEngine
  let E;
  if (typeof module !== 'undefined' && module.exports) {
    E = require('./engine.core.js');
  } else if (typeof DSQEngine !== 'undefined') {
    E = DSQEngine;
  } else if (typeof self !== 'undefined' && self.DSQEngine) {
    E = self.DSQEngine;
  } else {
    throw new Error('engine.mcts.js 需要先加载 engine.core.js（规则模块）');
  }
  if (!E || typeof E.genAll !== 'function') {
    throw new Error('engine.mcts.js 找不到可用的规则模块');
  }

  const { RED, GREEN, DENS, VAL, WIN, DEAD, MAP_DEAD } = E;

  // ================ 开局书（可选）================
  // 书来自 openbook.js 对 minimax 自对弈的统计（book.json），启动时自动加载；
  // 局面命中书中条目时直接按书走，不消耗搜索时间（可显著改善 MCTS 开局质量）。
  // 浏览器/油猴环境可在加载本文件前设置 self.DSQ_BOOK = <book.json 对象>。
  // 可用环境变量覆盖默认参数（供测试脚本调参）：
  //   DSQ_BOOK_OFF=1        关闭开局书
  //   DSQ_BOOK_TOPN=N       每个局面只取出现次数前 N 的走法（默认 4）
  //   DSQ_BOOK_PROB=P       按概率使用书中走法，0~1（默认 1）
  //   DSQ_BOOK_MINCNT=C     出现次数低于 C 的走法不用（默认 2，防噪声）
  const BOOK_TOPN = 4;
  const BOOK_PROB = 1;
  const BOOK_MINCNT = 2;

  let BOOK_TABLE = null;
  if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
    try { BOOK_TABLE = require('./book.json').table; } catch (e) { BOOK_TABLE = null; }
  } else if (typeof self !== 'undefined' && self.DSQ_BOOK) {
    BOOK_TABLE = self.DSQ_BOOK.table || self.DSQ_BOOK;
  }

  function bookMove(pos, avoidSet, sideToMove) {
    if (!BOOK_TABLE) return null;
    if (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_BOOK_OFF)) return null;
    if (typeof process !== 'undefined' && process.env && process.env.DSQ_BOOK_SIDE) {
      const bs = String(process.env.DSQ_BOOK_SIDE).toLowerCase();
      if ((bs === 'red' && sideToMove !== RED) || (bs === 'green' && sideToMove !== GREEN)) return null;
    }
    const entries = BOOK_TABLE[E.posKey(pos)];
    if (!entries || entries.length === 0) return null;
    const topN = (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_BOOK_TOPN)) || BOOK_TOPN;
    const prob = (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_BOOK_PROB)) || BOOK_PROB;
    const minCnt = (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_BOOK_MINCNT)) || BOOK_MINCNT;
    if (Math.random() >= prob) return null;
    let cands = entries.filter(e => e[2] >= minCnt).slice(0, Math.max(1, topN));
    if (cands.length === 0) return null;
    if (avoidSet && avoidSet.size > 0) {
      // 排除会造成历史重复局面（三同判和）的走法
      const base = Array.from(pos);
      const noRep = [];
      for (const e of cands) {
        const f = e[0], t = e[1];
        const p = base.slice();
        const b = E.boardFrom(p);
        const victim = b[t];
        b[p[f]] = E.MAP_DEAD; b[t] = p[f];
        p[f] = t;
        if (victim >= 0) p[victim] = E.DEAD;
        if (!avoidSet.has(p.join(','))) noRep.push(e);
      }
      cands = noRep;
      if (cands.length === 0) return null;
    }
    // 加权随机：权重 = 该走法在书中出现的次数（topN 内保留多样性）
    let total = 0;
    for (const e of cands) total += e[2];
    let r = Math.random() * total;
    let pick = cands[0];
    for (const e of cands) { r -= e[2]; if (r <= 0) { pick = e; break; } }
    const board = E.boardFrom(pos);
    const pieceId = board[pick[0]];
    if (pieceId < 0) return null; // 防御：书中坐标异常时回退搜索
    return { pieceId, from: pick[0], to: pick[1], victim: board[pick[1]] };
  }

  const UCB_C = 1.4;        // UCB1 探索常数（越大越爱探索）
  const PLAYOUT_CAP = 100;  // 单次模拟最长回合数（防死循环，超过判和）
  // 每次迭代都检查时间，避免长模拟造成大幅超时
  const MAX_ITER = 2000000; // 安全上限

  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

  function aliveCounts(pos) {
    const a = [0, 0];
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD) a[i < 8 ? RED : GREEN]++;
    }
    return a;
  }

  // 模拟（playout）策略：预筛选（吃子价值 + 向对方兽穴推进）前 5 个候选，
  // 再用评估函数精算选最优，保留少量随机（避免模拟太死板/纯随机太弱）
  function policyPick(moves, board, pos, alive, side) {
    const den = DENS[1 - side];
    const scored = [];
    for (const m of moves) {
      let s = Math.random() * 2;
      if (m.victim >= 0) s += VAL[m.victim % 8] * 10;
      const d = Math.abs(((m.to / 7) | 0) - ((den / 7) | 0)) + Math.abs((m.to % 7) - (den % 7));
      s -= d * 2;
      scored.push({ m, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const cand = scored.slice(0, Math.min(5, scored.length));
    let best = null, bestV = -Infinity;
    for (const c of cand) {
      const prev = E.applyMove(board, pos, alive, c.m);
      const v = E.evaluate(board, pos) * (side === RED ? 1 : -1);
      E.undoMove(board, pos, alive, c.m, prev);
      if (v > bestV) { bestV = v; best = c.m; }
    }
    if (!best) best = scored[0].m;
    return Math.random() < 0.8 ? best : moves[(Math.random() * moves.length) | 0];
  }

  // UCB1 选择子节点（优先未访问的子节点）
  function ucbSelect(node) {
    for (const c of node.children) if (c.visits === 0) return c;
    const ln = Math.log(Math.max(2, node.visits));
    let best = null, bestU = -Infinity;
    for (const c of node.children) {
      // 子节点胜率是“轮到对方行棋”的胜率，当前方应最大化 1 - 该胜率（负max形式）
      const u = (1 - c.wins / c.visits) + UCB_C * Math.sqrt(ln / c.visits);
      if (u > bestU) { bestU = u; best = c; }
    }
    return best;
  }

  // 从当前局面随机快进到终局，返回赢家（0红 1绿 -1和），走法追加进 applied 用于回退
  function playout(pos, board, alive, startSide, applied, prevs) {
    let side = startSide, plies = 0;
    const seen = new Set([E.posKey(pos)]);
    while (plies < PLAYOUT_CAP) {
      if (plies > 0) {
        const k = E.posKey(pos);
        if (seen.has(k)) return -1;   // 重复局面 -> 和
      }
      const moves = E.genAll(board, side === RED, pos);
      if (moves.length === 0) return 1 - side;  // 无棋可走 -> 输
      const m = policyPick(moves, board, pos, alive, side);
      const pv = E.applyMove(board, pos, alive, m);
      applied.push(m);      prevs.push(pv);
      if (m.to === DENS[side === RED ? GREEN : RED] || alive[1 - side] === 0) return side;
      seen.add(E.posKey(pos));
      side = 1 - side;
      plies++;
    }
    return -1; // 模拟超长 -> 和（防死局）
  }

  // 计算某走法之后的局面 key（不改变原局面）
  function keyAfter(pos, board, alive, m) {
    const savedFrom = pos[m.pieceId];
    const victim = board[m.to];
    const victimPos = victim >= 0 ? pos[victim] : -1;
    board[savedFrom] = MAP_DEAD; board[m.to] = m.pieceId; pos[m.pieceId] = m.to;
    if (victim >= 0) pos[victim] = DEAD;
    const k = E.posKey(pos);
    board[savedFrom] = m.pieceId; board[m.to] = victim; pos[m.pieceId] = savedFrom;
    if (victim >= 0) pos[victim] = victimPos;
    return k;
  }

  // ================ 主搜索：MCTS ================
  function mctsSearch(piecePos16, sideToMove, budgetMs, avoidKeys) {
    const pos = Int8Array.from(piecePos16);
    const board = E.boardFrom(pos);
    const alive = aliveCounts(pos);
    const avoidSet = avoidKeys && avoidKeys.length ? new Set(avoidKeys) : null;
    const t0 = now();
    const deadline = t0 + (budgetMs > 0 ? budgetMs : 50);

    const rootMoves = E.genAll(board, sideToMove === RED, pos);
    if (rootMoves.length === 0) {
      return { move: null, score: -WIN, depth: 0, nodes: 0, ms: 0 };
    }
    // 开局书优先：局面命中时直接按书走（book: true 供测试统计使用率）
    const bm = bookMove(pos, avoidSet, sideToMove);
    if (bm) {
      return { move: bm, score: 0, depth: 0, nodes: 0, ms: 0, book: true };
    }
    // 根节点走法排序：吃大子优先 + 随机扰动
    for (const m of rootMoves) m._s = Math.random() * 3 + (m.victim >= 0 ? VAL[m.victim % 8] * 10 : 0);
    rootMoves.sort((a, b) => b._s - a._s);

    const root = {
      side: sideToMove, moves: rootMoves,
      untried: rootMoves.slice(), children: [], visits: 0, wins: 0, depth: 0,
    };

    let iterations = 0, maxDepth = 0;

    while (iterations < MAX_ITER) {
      if (now() > deadline) break;
      iterations++;

      const visited = [root];
      const applied = [], prevs = [];
      let node = root;

      // 1) 按 UCB 沿已展开分支向下选择
      for (let guard = 0; guard < 10000; guard++) {
        if (node.untried.length > 0 || node.children.length === 0) break;
        const c = ucbSelect(node);
        if (!c) break;
        const prevC = E.applyMove(board, pos, alive, c.move);
        applied.push(c.move);        prevs.push(prevC);
        visited.push(c);
        node = c;
      }

      // 2) 扩展：当前节点无棋可走则直接判负，否则展开一个未尝试走法
      let winner;
      if (node.moves.length === 0) {
        winner = 1 - node.side;
      } else {
        const m = node.untried.pop();
        const prevM = E.applyMove(board, pos, alive, m);
        applied.push(m);        prevs.push(prevM);
        const child = { side: 1 - node.side, move: m, moves: null, untried: [], children: [], visits: 0, wins: 0, depth: node.depth + 1 };
        node.children.push(child);
        visited.push(child);
        if (child.depth > maxDepth) maxDepth = child.depth;

        if (m.to === DENS[node.side === RED ? GREEN : RED] || alive[1 - node.side] === 0) {
          winner = node.side;                     // 进兽穴 / 全歼
          child.moves = [];                       // 终端子节点：无棋可走，防止 null
        } else {
          const childMoves = E.genAll(board, child.side === RED, pos);
          child.moves = childMoves;
          if (childMoves.length === 0) {
            winner = node.side;                   // 对方无棋可走
          } else {
            // 子走法也按吃子优先排序，方便先展开关键分支
            for (const cm of childMoves) cm._s = Math.random() * 2 + (cm.victim >= 0 ? VAL[cm.victim % 8] * 10 : 1);
            childMoves.sort((a, b) => b._s - a._s);
            child.untried = childMoves.slice();
            // 3) 从子节点局面模拟到终局
            winner = playout(pos, board, alive, child.side, applied, prevs);
          }
        }
      }

      // 4) 回传结果
      for (const n of visited) {
        n.visits++;
        n.wins += winner === -1 ? 0.5 : winner === n.side ? 1 : 0;
      }

      // 5) 撤销本迭代所有走法，恢复根局面
      for (let i = applied.length - 1; i >= 0; i--) E.undoMove(board, pos, alive, applied[i], prevs[i]);
    }

    // 终选：访问数最多的子节点（稳健），优先排除造成历史重复的走法
    let best = null;
    for (const c of root.children) {
      if (!best || c.visits > best.visits) best = c;
    }
    if (!best) best = rootMoves[0]; // 极端情况（时间过短）
    if (avoidSet && root.children.length > 1) {
      const ok = [];
      for (const c of root.children) if (!avoidSet.has(keyAfter(pos, board, alive, c.move))) ok.push(c);
      if (ok.length) {
        best = ok[0];
        for (const c of ok) if (c.visits > best.visits) best = c;
      }
    }

    const ms = Math.round(now() - t0);
    const winRate = best.visits ? best.wins / best.visits : 0.5;
    const score = Math.round((winRate - 0.5) * 200);

    return {
      move: { pieceId: best.move.pieceId, from: best.move.from, to: best.move.to, victim: best.move.victim },
      score, depth: maxDepth, nodes: iterations, ms,
    };
  }

  // 返回一份“规则同核心、search 换成 MCTS”的独立引擎副本（不修改核心模块，便于双引擎对比/切换）
  return Object.assign({}, E, { search: mctsSearch });
});










