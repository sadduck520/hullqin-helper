/**
 * 跳棋（中国跳棋，非国际跳棋）引擎核心
 * 逆向自 game.hullqin.cn 前端 tq chunk 模块 4（走法生成 z/J/H、棋盘 U/L 坐标、营地 k/M、模式 f/h）
 *
 * 棋盘：121 格六边形星形；位置 idx → 轴坐标 (q,r)=U/L[idx]；六向邻接（共 312 条无向邻接）
 * 营地：camp i = 位置 10i..10i+9（10 子制）；15 子制每营另有 5 延伸格（M 表）
 * 目标：玩家所在营 c 的目标 = 营 (c+3)%6（对面）；全部棋子进入目标营 = 完胜
 * 走法：相邻空格单步；跳过棋子落到其镜像空格（落点=2*子-当前格，子与落点间须全空）；
 *       链跳不可重复落点；route = [起点, 落点...]；rule=1「超级跳」：同方向距离 2~7 的子
 *       只要贴身走廊全空也可跳（站点的一种规则变体）
 * 人数：2~6 人皆可（营地布局 mode 由人数决定）
 *
 * 本文件不依赖 DOM，可在 Node 中测试、也可内嵌进油猴脚本。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TQEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===== 棋盘坐标表（121 格，逆向自站点 U/L 数组）=====
  const U = [
    12, 11, 12, 10, 11, 12, 9, 10, 11, 12,
    16, 15, 15, 14, 14, 14, 13, 13, 13, 13,
    12, 12, 11, 12, 11, 10, 12, 11, 10, 9,
    4, 5, 4, 6, 5, 4, 7, 6, 5, 4,
    0, 1, 1, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 5, 4, 5, 6, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 7, 8, 9, 10, 11,
    12, 6, 7, 8, 9, 10, 11, 12, 5, 6,
    7, 8, 9, 10, 11, 12, 4, 5, 6, 7,
    8, 8, 7, 6, 5, 4, 9, 8, 7, 6,
    5, 4, 10, 9, 8, 7, 6, 5, 4, 11,
    10, 9, 8, 7, 6, 5, 4, 12, 11, 10,
    9
];
  const L = [
    0, 1, 1, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 5, 4, 5, 6, 4, 5, 6, 7,
    12, 11, 12, 10, 11, 12, 9, 10, 11, 12,
    16, 15, 15, 14, 14, 14, 13, 13, 13, 13,
    12, 12, 11, 12, 11, 10, 12, 11, 10, 9,
    4, 5, 4, 6, 5, 4, 7, 6, 5, 4,
    4, 4, 4, 4, 4, 5, 5, 5, 5, 5,
    5, 6, 6, 6, 6, 6, 6, 6, 7, 7,
    7, 7, 7, 7, 7, 7, 8, 8, 8, 8,
    8, 12, 12, 12, 12, 12, 11, 11, 11, 11,
    11, 11, 10, 10, 10, 10, 10, 10, 10, 9,
    9, 9, 9, 9, 9, 9, 9, 8, 8, 8,
    8
];
  const N_CELLS = 121;
  const cellIdx = new Map();
  for (let i = 0; i < N_CELLS; i++) cellIdx.set(U[i] + ',' + L[i], i);
  const ADJ = [];
  for (let i = 0; i < N_CELLS; i++) {
    const list = [];
    for (const [dq, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, -1], [-1, 1]]) {
      const j = cellIdx.get((U[i] + dq) + ',' + (L[i] + dr));
      if (j !== undefined) list.push(j);
    }
    ADJ.push(list);
  }

  // ===== 营地 =====
  const M15_EXTRA = [
    [60, 61, 62, 63, 64],
    [64, 70, 77, 85, 117],
    [117, 109, 102, 96, 91],
    [91, 92, 93, 94, 95],
    [95, 101, 108, 116, 86],
    [86, 78, 71, 65, 60],
  ];
  const campCells = (c, pieceCount) => {
    const base = [];
    for (let i = 0; i < 10; i++) base.push(10 * c + i);
    return pieceCount === 15 ? base.concat(M15_EXTRA[c]) : base;
  };
  const targetCampOf = c => (c + 3) % 6;
  const tipOf = c => 10 * targetCampOf(c);      // 目标营尖端（两种子数制下都是营地首格）

  // ===== 布局模式（逆向 f/h 表）：MODES[n-2] = 模式列表，模式[i] = 玩家 i 的营 =====
  const MODES = [
    [[0, 3], [0, 2], [0, 1]],                   // 2 人
    [[0, 2, 4], [0, 1, 2]],                     // 3 人
    [[0, 1, 3, 4], [0, 1, 2, 3], [0, 1, 2, 4]], // 4 人
    [[0, 1, 2, 3, 4]],                          // 5 人
    [[0, 1, 2, 3, 4, 5]],                       // 6 人
  ];
  const MODES15 = [[[0, 3], [0, 2]], [[0, 2, 4]]];   // 15 子制：仅 2/3 人
  const layoutOf = (playerCount, pieceCount, mode) => {
    const table = pieceCount === 15 ? MODES15[playerCount - 2] : MODES[playerCount - 2];
    if (!table) return null;
    return table[mode] !== undefined ? table[mode] : table[0];
  };

  // ===== 六向距离 =====
  const dist = (a, b) => {
    const dq = U[a] - U[b], dr = L[a] - L[b];
    return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
  };

  // ===== 轻量搜索状态 =====
  // view（站点已展开）: {rule, pieceCount, waitFor, playerPieces, winnerId, finish, pos, ...}
  function buildLight(view) {
    const occ = new Int16Array(N_CELLS);
    const pp = view.playerPieces.map(arr => arr.slice());
    for (let p = 0; p < pp.length; p++) {
      for (const pos of pp[p]) {
        if (pos >= 0 && pos < N_CELLS) occ[pos] = p + 1;
      }
    }
    return { occ, pp, playerCount: pp.length, pieceCount: view.pieceCount || 10, rule: view.rule ? 1 : 0 };
  }

  // ===== 走法生成（1:1 复刻站点 z/t2 语义）=====
  /** 玩家所有合法路线；route = [起点, 落点...]（起点拿起：视为空但不可重落） */
  function genRoutes(st, player) {
    const routes = [];
    const pieces = st.pp[player];
    if (!pieces) return routes;
    for (const origin of pieces) {
      if (origin >= 0 && origin < N_CELLS) routes.push.apply(routes, routesFrom(st, player, origin));
    }
    return routes;
  }

  function routesFrom(st, player, origin) {
    const occ = st.occ;
    occ[origin] = 0;
    const routes = [];
    const visited = new Set([origin]);
    // 单步
    for (const nb of ADJ[origin]) {
      if (occ[nb] === 0) routes.push([origin, nb]);
    }
    // 链跳 BFS
    let layer = [[origin, [origin]]];
    while (layer.length) {
      const next = [];
      for (const [cur, route] of layer) {
        for (const nb of ADJ[cur]) {
          if (occ[nb] !== 0) {
            tryJump(st, visited, routes, next, cur, route, nb);
          } else if (st.rule) {
            // 超级跳：沿 cur→nb 方向距离 2..7 找第一颗子（贴身走廊全空）
            const uq = U[nb] - U[cur], ur = L[nb] - L[cur];
            let q = U[cur] + uq * 2, r = L[cur] + ur * 2;
            for (let d = 2; d <= 7; d++) {
              const idx = cellIdx.get(q + ',' + r);
              if (idx === undefined) break;
              if (occ[idx] !== 0) { tryJump(st, visited, routes, next, cur, route, idx); break; }
              q += uq; r += ur;
            }
          }
        }
      }
      layer = next;
    }
    occ[origin] = player + 1;
    return routes;
  }

  /** 从 cur 跳过 piece（镜像落点 = 2*piece - cur；piece 与落点之间须全空） */
  function tryJump(st, visited, routes, next, cur, route, piece) {
    const dq = U[piece] - U[cur], dr = L[piece] - L[cur];
    const d = Math.max(Math.abs(dq), Math.abs(dr));
    const uq = dq / d, ur = dr / d;                 // 单位方向（整数）
    for (let k = 1; k < d; k++) {                   // piece → 落点 走廊
      const idx = cellIdx.get((U[piece] + uq * k) + ',' + (L[piece] + ur * k));
      if (idx === undefined || st.occ[idx] !== 0) return;
    }
    const land = cellIdx.get((U[piece] + uq * d) + ',' + (L[piece] + ur * d));
    if (land === undefined || visited.has(land) || st.occ[land] !== 0) return;
    visited.add(land);
    const r2 = route.concat([land]);
    routes.push(r2);
    next.push([land, r2]);
  }

  // ===== 胜负 =====
  /** 玩家是否完胜（所有棋子进入目标营） */
  function isWin(st, player, campLayout) {
    const target = new Set(campCells(targetCampOf(campLayout[player]), st.pieceCount));
    for (const pos of st.pp[player]) if (!target.has(pos)) return false;
    return true;
  }
  /** 玩家在目标营内的深度和（完胜进度，越大越好） */
  function inTargetDepth(st, player, campLayout) {
    const cells = campCells(targetCampOf(campLayout[player]), st.pieceCount);
    const order = cells.slice().sort((a, b) => dist(a, tipOf(campLayout[player])) - dist(b, tipOf(campLayout[player])));
    let sum = 0;
    for (const pos of st.pp[player]) {
      const k = order.indexOf(pos);
      if (k >= 0) sum += order.length - k;          // 越靠近尖端（k 小）分越高
    }
    return sum;
  }

  // ===== 应用/撤销 =====
  function applyRoute(st, route) {
    const from = route[0], to = route[route.length - 1];
    const player = st.occ[from] - 1;
    const pp = st.pp[player];
    const i = pp.indexOf(from);
    pp[i] = to;
    st.occ[from] = 0; st.occ[to] = player + 1;
    return { from, player, idx: i };
  }
  function undoRoute(st, route, undo) {
    const to = route[route.length - 1];
    st.pp[undo.player][undo.idx] = undo.from;
    st.occ[to] = 0; st.occ[undo.from] = undo.player + 1;
  }

  // ===== 评估（玩家视角，越大越好；负的行进距离和）=====
  function evaluate(st, player, campLayout) {
    const tip = tipOf(campLayout[player]);
    let sum = 0, maxD = 0;
    for (const pos of st.pp[player]) {
      const d = dist(pos, tip);
      sum += d;
      if (d > maxD) maxD = d;
    }
    return -(sum + maxD * 1.5) + inTargetDepth(st, player, campLayout) * 12;
  }

  // ===== 评估 =====
  /** 玩家的空目标格列表 */
  function freeTargets(st, player, campLayout) {
    const cells = campCells(targetCampOf(campLayout[player]), st.pieceCount);
    return cells.filter(c => st.occ[c] === 0);
  }
  /** pos 到最近空目标格的距离（满营时退化为到营尖距离） */
  function cellTargetDist(st, player, campLayout, pos, free) {
    const list = free || freeTargets(st, player, campLayout);
    if (!list.length) return dist(pos, tipOf(campLayout[player]));
    let m = Infinity;
    for (const c of list) {
      const d = dist(pos, c);
      if (d < m) m = d;
    }
    return m;
  }
  /** 已入目标营的棋子集合判定 */
  function inTarget(st, player, campLayout, pos) {
    const cells = campCells(targetCampOf(campLayout[player]), st.pieceCount);
    return cells.indexOf(pos) >= 0;
  }
  /** 未入营棋子列表 */
  function unsettled(st, player, campLayout) {
    return st.pp[player].filter(p => !inTarget(st, player, campLayout, p));
  }
  /**
   * 一条路线的即时进展（tip = 目标营尖端固定点，无占用电导致的指标退化）：
   *  - 已入营子离开目标营 → -100（严禁）；营内向尖端腾挪 → 正奖励（深格优先填，防止封口）
   *  - 未入营子 → 尖端距离差；进入目标营另有深度奖励
   */
  const routeDelta = (st, player, campLayout, route) => {
    const from = route[0], to = route[route.length - 1];
    const tip = tipOf(campLayout[player]);
    if (inTarget(st, player, campLayout, from)) {
      if (!inTarget(st, player, campLayout, to)) return -100;   // 禁止出营
      return dist(from, tip) - dist(to, tip);
    }
    let delta = dist(from, tip) - dist(to, tip);
    if (inTarget(st, player, campLayout, to)) delta += (4 - dist(to, tip)) * 1.5;   // 深处优先填
    return delta;
  };

  // ===== 搜索 =====
  /**
   * 2 人局：negamax 式深度 2~3（候选剪枝）；多人局：走后梯队代价最小者。
   * opts.avoidKeys：近期局面 key 列表（view.playerPieces.flat join）——重复位置递增扣分，
   * 防止在等值 Plateau 上来回横跳（跳棋残局常见死循环）。
   * @returns {route, score, nodes} 无棋可走时 route=null
   */
  function search(view, playerIdx, opts) {
    const o = opts || {};
    const st = buildLight(view);
    const campLayout = view.pos;
    const noise = o.noise || 0;
    const repCount = new Map();
    if (o.avoidKeys && o.avoidKeys.length) {
      for (const k of o.avoidKeys) repCount.set(k, (repCount.get(k) || 0) + 1);
    }
    const stateKey = s => s.pp.map(a => a.join('+')).join('|');
    const routes = genRoutes(st, playerIdx);
    if (!routes.length) return { route: null, score: 0, nodes: 0 };
    for (const r of routes) {
      r._delta = routeDelta(st, playerIdx, campLayout, r);
      r._win = routeWins(st, playerIdx, campLayout, r);
      // 走完后的局面重复次数（用于根节点降分）
      const undo0 = applyRoute(st, r);
      r._rep = repCount.get(stateKey(st)) || 0;
      undoRoute(st, r, undo0);
    }
    routes.sort((a, b) => (b._win - a._win) || (b._delta - a._delta));

    /** 候选多样性：每个棋子取前 N 条最优路线（防止单纯按 delta 截断时
     *  把「后方慢步发展」着法全部过滤掉——那是梯次推进的关键） */
    function pickDiverse(list, perPiece, cap) {
      const byPiece = new Map();
      for (const r of list) {
        const arr = byPiece.get(r[0]);
        if (arr) arr.push(r); else byPiece.set(r[0], [r]);
      }
      const out = [];
      for (let round = 0; round < perPiece && out.length < cap; round++) {
        for (const arr of byPiece.values()) {
          if (arr.length > round) {
            out.push(arr[round]);
            if (out.length >= cap) break;
          }
        }
      }
      return out;
    }

    if (st.playerCount === 2) {
      const depth = Math.max(2, Math.min(o.depth || 2, 3));
      const cands = pickDiverse(routes, depth >= 3 ? 2 : 3, depth >= 3 ? 20 : 24);
      let best = null, bestScore = -Infinity, nodes = 0;
      const rootScores = o.debug ? [] : null;
      for (const r of cands) {
        const undo = applyRoute(st, r);
        let sc;
        if (r._win || isWin(st, playerIdx, campLayout)) {
          sc = 1e9;
        } else {
          sc = -negamax(st, campLayout, 1 - playerIdx, depth - 1);
        }
        undoRoute(st, r, undo);
        nodes++;
        if (r._rep) sc -= 120 + 120 * r._rep;              // 重复局面递增惩罚
        if (noise && depth >= 2) sc += (Math.random() - 0.5) * noise;
        if (rootScores) rootScores.push({ route: r.join('->'), sc: Math.round(sc * 10) / 10, delta: Math.round(r._delta * 10) / 10, rep: r._rep });
        if (sc > bestScore) { bestScore = sc; best = r; }
      }
      const res = { route: best, score: bestScore, nodes };
      if (rootScores) res.rootScores = rootScores;
      return res;
    }
    // 多人贪心：走完后梯队代价最小者（含少量随机，避免机械化走法）
    const cands = routes.slice(0, 24);
    const scored = cands.map(r => {
      const undo = applyRoute(st, r);
      let sc = -rawDist(st, playerIdx, campLayout) * 1
        + inTargetDepth(st, playerIdx, campLayout) * 3
        + (noise ? Math.random() * noise : 0);
      if (r._rep) sc -= 120 + 120 * r._rep;
      undoRoute(st, r, undo);
      return { r, sc };
    });
    scored.sort((a, b) => b.sc - a.sc);
    const pick = scored[0];
    return { route: pick.r, score: pick.sc, nodes: cands.length };

    // ---- 内部：标准 negamax（返回值一律为「行棋方 mover 视角」）----
    function negamax(st, campLayout, mover, remaining) {
      const routes2 = genRoutes(st, mover);
      if (!routes2.length) return -500;                     // 无棋可走：极差（跳棋几乎不发生）
      for (const r of routes2) {
        r._delta = routeDelta(st, mover, campLayout, r);
        r._win = routeWins(st, mover, campLayout, r);
      }
      routes2.sort((a, b) => (b._win - a._win) || (b._delta - a._delta));
      const cands = pickDiverse(routes2, 2, 12);
      let best = -Infinity;
      for (const r of cands) {
        const undo = applyRoute(st, r);
        let sc;
        if (r._win || isWin(st, mover, campLayout)) sc = 1e9;
        else if (remaining <= 1) {
          sc = leafEval(st, campLayout, mover);
        } else {
          sc = -negamax(st, campLayout, 1 - mover, remaining - 1);
        }
        undoRoute(st, r, undo);
        if (sc > best) best = sc;
      }
      return best;
    }
    /** 叶评估（mover 视角）：未入营子的「空目标距和 + 拖尾惩罚」差 + 目标营深度差 */
    function leafEval(st, campLayout, mover) {
      const myE = rawDist(st, mover, campLayout);
      const opE = rawDist(st, 1 - mover, campLayout);
      return opE - myE + (inTargetDepth(st, mover, campLayout) - inTargetDepth(st, 1 - mover, campLayout)) * 12;
    }
    /** 未入营子的「梯队代价」：距离平方和 + 散布差惩罚。
     *  平方项 → 落后子进展收益更大；散布项 → 先锋不许脱离大部队冲刺（防堵门死局）。 */
    function rawDist(st, player, campLayout) {
      const tip = tipOf(campLayout[player]);
      const list = unsettled(st, player, campLayout);
      let sum = 0, maxD = 0, minD = Infinity;
      for (const pos of list) {
        const d = dist(pos, tip);
        sum += d * d;
        if (d > maxD) maxD = d;
        if (d < minD) minD = d;
      }
      if (minD === Infinity) minD = 0;
      return sum + (maxD - minD) * 8;
    }
  }
  /** 走完这条路线是否直接完胜 */
  function routeWins(st, player, campLayout, route) {
    const target = new Set(campCells(targetCampOf(campLayout[player]), st.pieceCount));
    const rest = st.pp[player].filter(p => p !== route[0]);
    for (const pos of rest) if (!target.has(pos)) return false;
    return target.has(route[route.length - 1]);
  }

  return {
    U, L, N_CELLS, ADJ, cellIdx,
    campCells, targetCampOf, tipOf, MODES, MODES15, layoutOf, dist,
    buildLight, genRoutes, routesFrom, applyRoute, undoRoute,
    isWin, inTargetDepth, evaluate, routeDelta, routeWins, search,
  };
});
