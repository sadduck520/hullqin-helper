/**
 * 斗兽棋引擎核心 —— 规则 1:1 逆向自 game.hullqin.cn 前端代码（模块 6390 的 sP/oe/qv）
 * 坐标：pos = row * 7 + col，row 0 为绿方底线（棋盘顶部），红方在 6-8 行
 * 棋子 id：0-7 红方（象狮虎豹狼狗猫鼠），8-15 绿方，id%8 = 类型
 * 类型编号越小越强：0象 1狮 2虎 3豹 4狼 5狗 6猫 7鼠（鼠吃象为特例）
 * 本文件不依赖 DOM，可在 Node 中测试、也可内嵌进油猴脚本
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DSQEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEAD = 63;          // 与游戏 OI.DEAD 一致：piecePos 中阵亡棋子的值
  const MAP_DEAD = -1;      // 棋盘空格
  const RED = 0, GREEN = 1;
  // 初始局面（游戏源码 LC()）
  const INIT_POS = [42, 62, 56, 46, 44, 54, 50, 48, 20, 0, 6, 16, 18, 8, 12, 14];
  const DENS = [59, 3];     // [红方兽穴(row8,col3), 绿方兽穴(row0,col3)]
  // 己方陷阱（红: (2,8)(4,8)(3,7)；绿: (2,0)(4,0)(3,1)）—— pos 值
  const TRAPS = [
    new Set([8 * 7 + 2, 8 * 7 + 4, 7 * 7 + 3]),
    new Set([0 * 7 + 2, 0 * 7 + 4, 1 * 7 + 3]),
  ];
  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // [dCol, dRow]
  const EMOJI = ['🐘', '🦁', '🐯', '🐆', '🐺', '🐶', '🐱', '🐭'];
  const NAMES = ['象', '狮', '虎', '豹', '狼', '狗', '猫', '鼠'];
  const VAL = [650, 520, 470, 350, 270, 230, 200, 190]; // 象狮虎豹狼狗猫鼠
  const WIN = 1000000;
  const isWater = (c, r) => ((c >= 1 && c <= 2) || (c >= 4 && c <= 5)) && r >= 3 && r <= 5;

  function boardFrom(pos) {
    const b = new Int8Array(63).fill(MAP_DEAD);
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD) b[p] = i;
    }
    return b;
  }

  // 大小吃子判定（逆向 y 函数）
  function canEat(attType, defType) {
    if (attType === 7 && defType === 0) return true;   // 鼠吃象
    if (attType === 0 && defType === 7) return false;  // 象不吃鼠
    return attType <= defType;                          // 编号小者强，同级可互吃
  }

  /**
   * 走子生成 —— 严格复刻游戏 sP(e,n)：
   * - 兽穴不可自入；仅鼠可入河；狮虎沿直线跳河（河中有任何棋子则被挡）
   * - 水中的鼠不能吃陆地上的非鼠棋子（可吃陆地/水中的鼠）
   * - 敌方棋子处于"我方陷阱"时，任意棋子可吃；空陷阱可自由进入
   * @param {Int8Array} board 63格棋盘（值为棋子id或-1）
   * @param {number} pieceId
   * @param {number} [knownPos] 已知棋子位置（跳过扫描）
   */
  function genMoves(board, pieceId, knownPos) {
    const res = [];
    const isRed = pieceId < 8;
    let pos = knownPos;
    if (pos === undefined || board[pos] !== pieceId) {
      pos = -1;
      for (let p = 0; p < 63; p++) if (board[p] === pieceId) { pos = p; break; }
    }
    if (pos === undefined || pos < 0) return res;
    const col = pos % 7, row = (pos / 7) | 0;
    const type = pieceId % 8;
    const ownDen = DENS[isRed ? RED : GREEN];
    const myTraps = TRAPS[isRed ? RED : GREEN];
    for (const [dc, dr] of DIRS) {
      let c = col + dc, r = row + dr;
      if (c < 0 || c > 6 || r < 0 || r > 8) continue;
      if (r * 7 + c === ownDen) continue;                    // 不可入己方兽穴
      if (isWater(c, r)) {
        if (type === 1 || type === 2) {                      // 狮/虎跳河
          let blocked = false;
          while (isWater(c, r)) {
            if (board[r * 7 + c] !== MAP_DEAD) { blocked = true; break; }
            c += dc; r += dr;
          }
          if (blocked || c < 0 || c > 6 || r < 0 || r > 8) continue;
        } else if (type !== 7) continue;                     // 只有鼠能下水
      }
      const target = board[r * 7 + c];
      if (target >= 0 && (target < 8) === isRed) continue;   // 己方棋子占据
      if (target >= 0) {
        if (type === 7 && isWater(col, row) && !isWater(c, r) && (target % 8) !== 7) continue; // 水鼠不吃陆上非鼠
        if (myTraps.has(r * 7 + c)) { res.push(r * 7 + c); continue; } // 敌子在我方陷阱：任意吃
        if (canEat(type, target % 8)) res.push(r * 7 + c);
      } else {
        res.push(r * 7 + c);
      }
    }
    return res;
  }

  /**
   * 某一方所有合法走法 [{pieceId, from, to, victim}]
   * @param {number[]} [pos16] 棋子位置数组（提供则免扫描，性能好很多）
   */
  function genAll(board, isRed, pos16) {
    const list = [];
    for (let i = isRed ? 0 : 8, end = isRed ? 8 : 16; i < end; i++) {
      const from = pos16 ? pos16[i] : undefined;
      if (pos16 && (!(from >= 0 && from < DEAD))) continue;
      const moves = genMoves(board, i, pos16 ? from : undefined);
      for (const to of moves) list.push({ pieceId: i, from: pos16 ? from : -1, to, victim: board[to] });
    }
    return list;
  }

  function applyMove(board, pos, alive, m) {
    const prev = { from: pos[m.pieceId], victim: board[m.to] };
    board[pos[m.pieceId]] = MAP_DEAD;
    board[m.to] = m.pieceId;
    pos[m.pieceId] = m.to;
    if (prev.victim >= 0) { pos[prev.victim] = DEAD; alive[prev.victim < 8 ? RED : GREEN]--; }
    return prev;
  }
  function undoMove(board, pos, alive, m, prev) {
    board[m.to] = prev.victim;
    board[prev.from] = m.pieceId;
    pos[m.pieceId] = prev.from;
    if (prev.victim >= 0) { pos[prev.victim] = m.to; alive[prev.victim < 8 ? RED : GREEN]++; }
  }

  // 评估（红方视角，正值利于红）
  function evaluate(board, pos) {
    let score = 0, redEle = false, greenEle = false;
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD && i % 8 === 0) { if (i < 8) redEle = true; else greenEle = true; }
    }
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (!(p >= 0 && p < DEAD)) continue;
      const side = i < 8 ? RED : GREEN;
      const type = i % 8, col = p % 7, row = (p / 7) | 0;
      let v = VAL[type];
      if (type === 7) v += (side === RED ? greenEle : redEle) ? 110 : -60; // 对面还有象时鼠更值钱
      const den = DENS[side === RED ? GREEN : RED];
      const dist = Math.abs(((den / 7) | 0) - row) + Math.abs((den % 7) - col);
      let adv = (12 - dist) * (type === 1 || type === 2 ? 5 : 4);
      if (dist <= 2) adv += (3 - dist) * 150;                 // 兽穴门口的重压
      const enemyTraps = TRAPS[side === RED ? GREEN : RED];
      if (enemyTraps.has(p)) {                                 // 深陷敌陷阱且旁有敌子 → 危
        for (const [dc, dr] of DIRS) {
          const c = col + dc, r = row + dr;
          if (c < 0 || c > 6 || r < 0 || r > 8) continue;
          const q = board[r * 7 + c];
          if (q >= 0 && (q < 8) !== (side === RED)) { v -= VAL[type] * 0.55; break; }
        }
      }
      score += (side === RED ? 1 : -1) * (v + adv);
    }
    return score;
  }

  const posKey = (pos) => pos.join(',');

  /**
   * 搜索：negamax + α-β + 迭代加深 + 时间预算 + 重复局面规避
   * @param {Int8Array|number[]} piecePos16
   * @param {number} sideToMove 0红 1绿
   * @param {number} budgetMs
   * @param {string[]} [avoidKeys] 历史局面 key 列表（规避来回重复）
   */
  function search(piecePos16, sideToMove, budgetMs, avoidKeys) {
    const pos = Int8Array.from(piecePos16);
    const board = boardFrom(pos);
    const alive = [0, 0];
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD) alive[i < 8 ? RED : GREEN]++;
    }
    // 深度控制（仅测试外壳，不改搜索算法）：DSQ_FIXED_DEPTH=N 固定深度、不限制时间
    const fixedDepth = (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_FIXED_DEPTH)) || 0;
    const maxDepthOpt = (typeof process !== 'undefined' && process.env && Number(process.env.DSQ_MAX_DEPTH)) || 14;
    const maxDepth = fixedDepth > 0 ? Math.min(Math.max(2, fixedDepth), 30) : maxDepthOpt;
    const now0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deadline = fixedDepth > 0 ? Infinity : now0 + budgetMs;
    let nodes = 0, aborted = false;
    const avoidSet = avoidKeys && avoidKeys.length ? new Set(avoidKeys) : null;

    function timeUp() {
      if ((++nodes & 511) !== 0) return false;
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) > deadline) { aborted = true; return true; }
      return false;
    }

    function negamax(depth, alpha, beta, side, ply) {
      if (timeUp()) return 0;
      const moves = genAll(board, side === RED, pos);
      if (moves.length === 0) return -(WIN - ply);            // 无棋可走 = 输
      if (moves.length > 1) {
        for (const m of moves) m._s = m.victim >= 0 ? VAL[m.victim % 8] * 10 - VAL[m.pieceId % 8] / 10 : 0;
        moves.sort((a, b) => b._s - a._s);
      }
      let best = -Infinity;
      for (const m of moves) {
        const prev = applyMove(board, pos, alive, m);
        let score;
        if (m.to === DENS[side === RED ? GREEN : RED] || alive[side === RED ? GREEN : RED] === 0) {
          score = WIN - ply - 1;                               // 进兽穴 / 全歼
        } else if (depth <= 1) {
          score = (side === RED ? 1 : -1) * evaluate(board, pos);
        } else {
          score = -negamax(depth - 1, -beta, -alpha, side === RED ? GREEN : RED, ply + 1);
        }
        undoMove(board, pos, alive, m, prev);
        if (aborted) return 0;
        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    const rootMoves = genAll(board, sideToMove === RED, pos);
    if (rootMoves.length === 0) return { move: null, score: -WIN, depth: 0, nodes: 0, ms: 0 };
    for (const m of rootMoves) m._s = Math.random() * 3 + (m.victim >= 0 ? VAL[m.victim % 8] * 10 : 0);
    rootMoves.sort((a, b) => b._s - a._s);

    // 根节点走法会导致的重复局面 → 排序沉底 + 终选降分
    if (avoidSet) {
      for (const m of rootMoves) {
        const savedFrom = pos[m.pieceId];
        const victim = board[m.to];
        const victimPos = victim >= 0 ? pos[victim] : -1;
        board[savedFrom] = MAP_DEAD; board[m.to] = m.pieceId; pos[m.pieceId] = m.to;
        if (victim >= 0) pos[victim] = DEAD;
        m._rep = avoidSet.has(posKey(pos));
        board[savedFrom] = m.pieceId; board[m.to] = victim; pos[m.pieceId] = savedFrom;
        if (victim >= 0) pos[victim] = victimPos;
      }
      rootMoves.sort((a, b) => (a._rep ? 1 : 0) - (b._rep ? 1 : 0));
    }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let bestMove = rootMoves[0], bestScore = 0, finishedDepth = 0;
    for (let depth = 2; depth <= maxDepth; depth++) {
      let iterBest = null, iterScore = -Infinity;
      let alpha = -Infinity;
      const ordered = [bestMove, ...rootMoves.filter(m => m !== bestMove)];
      for (const m of ordered) {
        const prev = applyMove(board, pos, alive, m);
        let score;
        if (m.to === DENS[sideToMove === RED ? GREEN : RED] || alive[sideToMove === RED ? GREEN : RED] === 0) {
          score = WIN - 1;
        } else {
          score = -negamax(depth - 1, -Infinity, -alpha, sideToMove === RED ? GREEN : RED, 1);
        }
        undoMove(board, pos, alive, m, prev);
        if (aborted) break;
        if (m._rep) score -= 500;                              // 重复局面降分
        if (score > iterScore) { iterScore = score; iterBest = m; }
        if (score > alpha) alpha = score;
      }
      if (aborted) break;
      bestMove = iterBest; bestScore = iterScore; finishedDepth = depth;
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return {
      move: { pieceId: bestMove.pieceId, from: bestMove.from, to: bestMove.to, victim: bestMove.victim },
      score: bestScore, depth: finishedDepth, nodes, ms: Math.round(ms),
    };
  }

  return {
    DEAD, MAP_DEAD, RED, GREEN, INIT_POS, DENS, TRAPS, DIRS, EMOJI, NAMES, VAL, WIN,
    isWater, boardFrom, canEat, genMoves, genAll, applyMove, undoMove, evaluate, search, posKey,
  };
});

