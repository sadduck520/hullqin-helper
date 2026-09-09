/**
 * 国际象棋自研引擎核心（路线 B）
 * 规则完整：王车易位、吃过路兵、升变、将军/将死/逼和、50 步规则
 * 搜索：negamax + α-β 剪枝 + 迭代加深 + 静态搜索(quiescence) + MVV-LVA + 将军延伸
 * 评估：子力 + 位置表（Simplified Evaluation Function）
 * 坐标：pos = y*8 + x，y=0 为黑方底线（rank 8），与 game.hullqin.cn 一致
 * 棋子编码：0空；白 P1 N2 B3 R4 Q5 K6；黑 = 白+8（P9..K14）
 * 本文件不依赖 DOM，可在 Node 测试，也可内嵌油猴脚本
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPTY = 0, WP = 1, WN = 2, WB = 3, WR = 4, WQ = 5, WK = 6;
  const TYPE = [0, 1, 2, 3, 4, 5, 6, 0, 0, 1, 2, 3, 4, 5, 6]; // code -> 1..6
  const isW = c => c > 0 && c < 8, isB = c => c > 8;
  const VAL = [0, 100, 320, 330, 500, 900, 20000];

  // 位置表（Michniewski 简化评估，白方视角，索引 pos=y*8+x，y=0 为 rank8）
  const PST_P = [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0];
  const PST_N = [
   -50,-40,-30,-30,-30,-30,-40,-50,
   -40,-20,  0,  0,  0,  0,-20,-40,
   -30,  0, 10, 15, 15, 10,  0,-30,
   -30,  5, 15, 20, 20, 15,  5,-30,
   -30,  0, 15, 20, 20, 15,  0,-30,
   -30,  5, 10, 15, 15, 10,  5,-30,
   -40,-20,  0,  5,  5,  0,-20,-40,
   -50,-40,-30,-30,-30,-30,-40,-50];
  const PST_B = [
   -20,-10,-10,-10,-10,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5, 10, 10,  5,  0,-10,
   -10,  5,  5, 10, 10,  5,  5,-10,
   -10,  0, 10, 10, 10, 10,  0,-10,
   -10, 10, 10, 10, 10, 10, 10,-10,
   -10,  5,  0,  0,  0,  0,  5,-10,
   -20,-10,-10,-10,-10,-10,-10,-20];
  const PST_R = [
     0,  0,  0,  0,  0,  0,  0,  0,
     5, 10, 10, 10, 10, 10, 10,  5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
    -5,  0,  0,  0,  0,  0,  0, -5,
     0,  0,  0,  5,  5,  0,  0,  0];
  const PST_Q = [
   -20,-10,-10, -5, -5,-10,-10,-20,
   -10,  0,  0,  0,  0,  0,  0,-10,
   -10,  0,  5,  5,  5,  5,  0,-10,
    -5,  0,  5,  5,  5,  5,  0, -5,
     0,  0,  5,  5,  5,  5,  0, -5,
   -10,  5,  5,  5,  5,  5,  0,-10,
   -10,  0,  5,  0,  0,  0,  0,-10,
   -20,-10,-10, -5, -5,-10,-10,-20];
  const PST_K = [
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -30,-40,-40,-50,-50,-40,-40,-30,
   -20,-30,-30,-40,-40,-30,-30,-20,
   -10,-20,-20,-20,-20,-20,-20,-10,
    20, 20,  0,  0,  0,  0, 20, 20,
    20, 30, 10,  0,  0, 10, 30, 20];
  const PSTS = [null, PST_P, PST_N, PST_B, PST_R, PST_Q, PST_K];
  // 黑方视角：y 镜像翻转
  const PSTS_B = {};
  for (let t = 1; t <= 6; t++) {
    const arr = new Int16Array(64);
    for (let p = 0; p < 64; p++) arr[p] = PSTS[t][(7 - (p >> 3)) * 8 + (p & 7)];
    PSTS_B[t] = arr;
  }

  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KG = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const RD = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const BD = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const MATE = 1000000;

  // ---------- 局面 ----------
  function newState() {
    return { board: new Int8Array(64), whiteTurn: true, castle: 15, ep: -1, half: 0, full: 1, kings: [60, 4] };
  }
  function findKing(s, white) {
    const k = white ? WK : WK + 8;
    for (let i = 0; i < 64; i++) if (s.board[i] === k) return i;
    return -1;
  }
  function setupStart(s) {
    s.board.fill(0);
    const back = [WR, WN, WB, WQ, WK, WB, WN, WR];
    for (let x = 0; x < 8; x++) {
      s.board[8 + x] = WP + 8;
      s.board[48 + x] = WP;
      s.board[56 + x] = back[x];
      s.board[x] = back[x] + 8;
    }
    s.whiteTurn = true; s.castle = 15; s.ep = -1; s.half = 0;
    s.kings = [60, 4];
  }
  function cloneState(s) {
    return { board: Int8Array.from(s.board), whiteTurn: s.whiteTurn, castle: s.castle, ep: s.ep, half: s.half, kings: s.kings.slice() };
  }
  function toFEN(s) {
    const rows = [];
    for (let y = 0; y < 8; y++) {
      let row = '', run = 0;
      for (let x = 0; x < 8; x++) {
        const c = s.board[y * 8 + x];
        if (c === 0) { run++; continue; }
        if (run) { row += run; run = 0; }
        const sym = 'PNBRQK'[TYPE[c] - 1];
        row += c < 8 ? sym : sym.toLowerCase();
      }
      if (run) row += run;
      rows.push(row);
    }
    let castle = '';
    if (s.castle & 1) castle += 'K';
    if (s.castle & 2) castle += 'Q';
    if (s.castle & 4) castle += 'k';
    if (s.castle & 8) castle += 'q';
    const ep = s.ep >= 0 ? 'abcdefgh'[s.ep & 7] + (8 - (s.ep >> 3)) : '-';
    return rows.join('/') + ' ' + (s.whiteTurn ? 'w' : 'b') + ' ' + (castle || '-') + ' ' + ep + ' ' + s.half + ' ' + (s.full || 1);
  }
  function fromFEN(fen) {
    const s = newState();
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');
    for (let y = 0; y < 8; y++) {
      let x = 0;
      for (const ch of rows[y]) {
        if (ch >= '1' && ch <= '8') { x += +ch; continue; }
        const t = 'PNBRQK'.indexOf(ch.toUpperCase()) + 1;
        const code = ch === ch.toUpperCase() ? t : t + 8;
        s.board[y * 8 + x] = code;
        x++;
      }
    }
    s.whiteTurn = parts[1] !== 'b';
    s.castle = 0;
    if (parts[2] && parts[2] !== '-') {
      if (parts[2].includes('K')) s.castle |= 1;
      if (parts[2].includes('Q')) s.castle |= 2;
      if (parts[2].includes('k')) s.castle |= 4;
      if (parts[2].includes('q')) s.castle |= 8;
    }
    s.ep = (parts[3] && parts[3] !== '-') ? ('abcdefgh'.indexOf(parts[3][0]) + (8 - +parts[3][1]) * 8) : -1;
    s.half = +parts[4] || 0;
    s.full = +parts[5] || 1;
    s.kings = [findKing(s, true), findKing(s, false)];
    return s;
  }
  function posKeyFull(s) { return toFEN(s).split(' ').slice(0, 4).join(' '); }

  // ---------- 攻击 ----------
  function attacked(s, sq, byWhite) {
    const b = s.board;
    const py = (sq >> 3) + (byWhite ? 1 : -1);
    if (py >= 0 && py < 8) {
      const pawn = byWhite ? WP : WP + 8, x = sq & 7;
      if (x > 0 && b[py * 8 + x - 1] === pawn) return true;
      if (x < 7 && b[py * 8 + x + 1] === pawn) return true;
    }
    const kn = byWhite ? WN : WN + 8, kx = sq & 7, ky = sq >> 3;
    for (let i = 0; i < 8; i++) {
      const x = kx + KN[i][0], y = ky + KN[i][1];
      if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === kn) return true;
    }
    const kk = byWhite ? WK : WK + 8;
    for (let i = 0; i < 8; i++) {
      const x = kx + KG[i][0], y = ky + KG[i][1];
      if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === kk) return true;
    }
    const R = byWhite ? WR : WR + 8, B = byWhite ? WB : WB + 8, Q = byWhite ? WQ : WQ + 8;
    for (let i = 0; i < 4; i++) {
      let x = kx + RD[i][0], y = ky + RD[i][1];
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const c = b[y * 8 + x];
        if (c !== 0) { if (c === R || c === Q) return true; break; }
        x += RD[i][0]; y += RD[i][1];
      }
    }
    for (let i = 0; i < 4; i++) {
      let x = kx + BD[i][0], y = ky + BD[i][1];
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const c = b[y * 8 + x];
        if (c !== 0) { if (c === B || c === Q) return true; break; }
        x += BD[i][0]; y += BD[i][1];
      }
    }
    return false;
  }
  function inCheck(s, white) { return attacked(s, white ? s.kings[0] : s.kings[1], !white); }

  // ---------- 走子 ----------
  // m = {from, to, promo(0|2..5), flag:'n'|'ep'|'ck'|'cq'|'2'}
  function genPseudo(s) {
    const b = s.board, white = s.whiteTurn, moves = [];
    const own = c => white ? isW(c) : isB(c);
    const enemy = c => white ? isB(c) : isW(c);
    for (let from = 0; from < 64; from++) {
      const c = b[from];
      if (c === 0 || !own(c)) continue;
      const t = TYPE[c], x = from & 7, y = from >> 3;
      if (t === 1) { // 兵
        const dir = white ? -1 : 1;
        const startRank = white ? 6 : 1, promoRank = white ? 0 : 7;
        const ny1 = y + dir;
        if (ny1 >= 0 && ny1 < 8 && b[ny1 * 8 + x] === 0) {
          if (ny1 === promoRank) for (const pr of [5, 2, 4, 3]) moves.push({ from, to: ny1 * 8 + x, promo: pr, flag: 'n' });
          else {
            moves.push({ from, to: ny1 * 8 + x, promo: 0, flag: 'n' });
            if (y === startRank && b[(y + 2 * dir) * 8 + x] === 0) moves.push({ from, to: (y + 2 * dir) * 8 + x, promo: 0, flag: '2' });
          }
        }
        for (const dx of [-1, 1]) {
          const nx = x + dx;
          if (nx < 0 || nx > 7 || ny1 < 0 || ny1 > 7) continue;
          const to = ny1 * 8 + nx, cap = b[to];
          if (enemy(cap)) {
            if (ny1 === promoRank) for (const pr of [5, 2, 4, 3]) moves.push({ from, to, promo: pr, flag: 'n' });
            else moves.push({ from, to, promo: 0, flag: 'n' });
          } else if (cap === 0 && to === s.ep) {
            moves.push({ from, to, promo: 0, flag: 'ep' });
          }
        }
      } else if (t === 2 || t === 6) { // 马/王
        const dirs = t === 2 ? KN : KG;
        for (let i = 0; i < 8; i++) {
          const nx = x + dirs[i][0], ny = y + dirs[i][1];
          if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
          const cap = b[ny * 8 + nx];
          if (own(cap)) continue;
          moves.push({ from, to: ny * 8 + nx, promo: 0, flag: 'n' });
        }
        if (t === 6) {
          if (white && from === 60) {
            if ((s.castle & 1) && b[61] === 0 && b[62] === 0 && b[63] === WR && !attacked(s, 60, false) && !attacked(s, 61, false) && !attacked(s, 62, false))
              moves.push({ from: 60, to: 62, promo: 0, flag: 'ck' });
            if ((s.castle & 2) && b[59] === 0 && b[58] === 0 && b[57] === 0 && b[56] === WR && !attacked(s, 60, false) && !attacked(s, 59, false) && !attacked(s, 58, false))
              moves.push({ from: 60, to: 58, promo: 0, flag: 'cq' });
          } else if (!white && from === 4) {
            if ((s.castle & 4) && b[5] === 0 && b[6] === 0 && b[7] === WR + 8 && !attacked(s, 4, true) && !attacked(s, 5, true) && !attacked(s, 6, true))
              moves.push({ from: 4, to: 6, promo: 0, flag: 'ck' });
            if ((s.castle & 8) && b[3] === 0 && b[2] === 0 && b[1] === 0 && b[0] === WR + 8 && !attacked(s, 4, true) && !attacked(s, 3, true) && !attacked(s, 2, true))
              moves.push({ from: 4, to: 2, promo: 0, flag: 'cq' });
          }
        }
      } else { // 车/象/后
        const dirs = t === 4 ? RD : t === 3 ? BD : (t === 5 ? RD.concat(BD) : []);
        for (let i = 0; i < dirs.length; i++) {
          let nx = x + dirs[i][0], ny = y + dirs[i][1];
          while (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
            const cap = b[ny * 8 + nx];
            if (own(cap)) break;
            moves.push({ from, to: ny * 8 + nx, promo: 0, flag: 'n' });
            if (cap !== 0) break;
            nx += dirs[i][0]; ny += dirs[i][1];
          }
        }
      }
    }
    return moves;
  }

  function makeMove(s, m) {
    const b = s.board, white = s.whiteTurn;
    const saved = { castle: s.castle, ep: s.ep, half: s.half, cap: b[m.to] };
    const piece = b[m.from];
    b[m.from] = 0;
    b[m.to] = m.promo ? (white ? m.promo : m.promo + 8) : piece;
    s.ep = -1;
    s.half = (saved.cap !== 0 || TYPE[piece] === 1) ? 0 : s.half + 1;
    if (m.flag === '2') s.ep = (m.from + m.to) / 2;
    if (m.flag === 'ep') {
      b[white ? m.to + 8 : m.to - 8] = 0;
      s.half = 0;
    }
    if (TYPE[piece] === 6) {
      s.kings[white ? 0 : 1] = m.to;
      if (m.flag === 'ck') { if (white) { b[63] = 0; b[61] = WR; } else { b[7] = 0; b[5] = WR + 8; } }
      else if (m.flag === 'cq') { if (white) { b[56] = 0; b[59] = WR; } else { b[0] = 0; b[3] = WR + 8; } }
    }
    if (!white) s.full++;
    if (m.from === 60 || m.from === 63 || m.to === 63) s.castle &= ~1;
    if (m.from === 60 || m.from === 56 || m.to === 56) s.castle &= ~2;
    if (m.from === 4 || m.from === 7 || m.to === 7) s.castle &= ~4;
    if (m.from === 4 || m.from === 0 || m.to === 0) s.castle &= ~8;
    s.whiteTurn = !white;
    return saved;
  }

  function unmakeMove(s, m, saved) {
    const b = s.board;
    const white = !s.whiteTurn; // 刚走子的一方
    b[m.from] = m.promo ? (white ? WP : WP + 8) : b[m.to];
    b[m.to] = saved.cap;
    if (m.flag === 'ep') b[white ? m.to + 8 : m.to - 8] = white ? WP + 8 : WP;
    const moved = b[m.from];
    if (TYPE[moved] === 6) {
      s.kings[white ? 0 : 1] = m.from;
      if (m.flag === 'ck') { if (white) { b[61] = 0; b[63] = WR; } else { b[5] = 0; b[7] = WR + 8; } }
      else if (m.flag === 'cq') { if (white) { b[59] = 0; b[56] = WR; } else { b[3] = 0; b[0] = WR + 8; } }
    }
    s.castle = saved.castle; s.ep = saved.ep; s.half = saved.half; s.whiteTurn = white;
    if (!white) s.full--;
  }

  function genLegal(s) {
    const legal = [];
    for (const m of genPseudo(s)) {
      const saved = makeMove(s, m);
      if (!inCheck(s, !s.whiteTurn)) legal.push(m);
      unmakeMove(s, m, saved);
    }
    return legal;
  }

  // ---------- 评估（白方视角，厘兵） ----------
  function evaluate(s) {
    let score = 0;
    const b = s.board;
    for (let p = 0; p < 64; p++) {
      const c = b[p];
      if (c === 0) continue;
      const t = TYPE[c];
      score += c < 8 ? (VAL[t] + PSTS[t][p]) : -(VAL[t] + PSTS_B[t][p]);
    }
    return score;
  }

  // ---------- 搜索 ----------
  let nodes = 0, deadline = 0, aborted = false;
  function timeUp() {
    if (aborted) return true;
    if ((nodes & 1023) === 0 && (typeof performance !== 'undefined' ? performance.now() : Date.now()) > deadline) aborted = true;
    return aborted;
  }
  function orderScore(s, m) {
    const b = s.board;
    let sc = 0;
    if (m.flag === 'ep') sc = 100000 + 100 * 16 - 100;
    else if (b[m.to] !== 0) sc = 100000 + VAL[TYPE[b[m.to]]] * 16 - VAL[TYPE[b[m.from]]];
    if (m.promo) sc += 90000 + VAL[m.promo];
    const t = TYPE[b[m.from]];
    sc += b[m.from] < 8 ? (PSTS[t][m.to] - PSTS[t][m.from]) : (PSTS_B[t][m.to] - PSTS_B[t][m.from]);
    return sc;
  }
  function quiesce(s, alpha, beta, ply) {
    nodes++;
    if (timeUp()) return 0;
    const white = s.whiteTurn;
    const stand = white ? evaluate(s) : -evaluate(s);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply > 24) return alpha;
    const b = s.board;
    const caps = genPseudo(s).filter(m => b[m.to] !== 0 || m.flag === 'ep' || m.promo);
    caps.sort((a, b2) => orderScore(s, b2) - orderScore(s, a));
    for (const m of caps) {
      const saved = makeMove(s, m);
      if (inCheck(s, !s.whiteTurn)) { unmakeMove(s, m, saved); continue; }
      const sc = -quiesce(s, -beta, -alpha, ply + 1);
      unmakeMove(s, m, saved);
      if (aborted) return 0;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  function negamax(s, depth, alpha, beta, ply, ext) {
    nodes++;
    if (timeUp()) return 0;
    const white = s.whiteTurn;
    const chk = inCheck(s, white);
    if (chk && ext < 3) depth++;
    if (depth <= 0) return quiesce(s, alpha, beta, ply);
    const moves = genLegal(s);
    if (moves.length === 0) return chk ? -MATE + ply : 0;
    if (s.half >= 100) return 0;
    moves.sort((a, b2) => orderScore(s, b2) - orderScore(s, a));
    let best = -Infinity;
    for (const m of moves) {
      const saved = makeMove(s, m);
      const sc = -negamax(s, depth - 1, -beta, -alpha, ply + 1, chk ? ext + 1 : 0);
      unmakeMove(s, m, saved);
      if (aborted) return 0;
      if (sc > best) best = sc;
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) break;
    }
    return best;
  }

  // 顶层搜索：opts {maxDepth, timeMs, avoid:[FEN前4段], noise(厘兵随机扰动)}
  function search(s, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 6;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    deadline = t0 + (opts.timeMs || 800);
    aborted = false; nodes = 0;
    const avoid = new Set(opts.avoid || []);
    const noise = opts.noise || 0;
    const legal = genLegal(s);
    if (legal.length === 0) return { move: null, score: 0, depth: 0, nodes: 0, ms: 0, root: [] };
    let scored = legal.map(m => ({ m, sc: orderScore(s, m) }));
    let best = scored[0].m, bestScore = 0, finished = 0;
    for (let depth = 1; depth <= maxDepth; depth++) {
      let iterBest = null, iterScore = -Infinity, alpha = -Infinity;
      for (const e of scored) {
        const m = e.m;
        const saved = makeMove(s, m);
        const afterKey = posKeyFull(s);
        let sc = -negamax(s, depth - 1, -Infinity, -alpha, 1, 0);
        unmakeMove(s, m, saved);
        if (aborted) break;
        if (avoid.has(afterKey)) sc -= 500;      // 重复局面降分
        if (noise > 0) sc += (Math.random() * 2 - 1) * noise;
        e.sc = sc;
        if (sc > iterScore) { iterScore = sc; iterBest = m; }
        if (sc > alpha) alpha = sc;
      }
      if (aborted) break;
      best = iterBest || best; bestScore = iterScore; finished = depth;
      scored.sort((a, b) => b.sc - a.sc);         // 上一轮分数做下一轮排序
    }
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    const root = scored.map(x => ({ m: { from: x.m.from, to: x.m.to, promo: x.m.promo }, sc: x.sc }));
    return { move: best, score: bestScore, depth: finished, nodes, ms, root };
  }

  function perft(s, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of genLegal(s)) {
      const saved = makeMove(s, m);
      n += perft(s, depth - 1);
      unmakeMove(s, m, saved);
    }
    return n;
  }

  const PIECE_CHAR = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];

  return {
    WP, WN, WB, WR, WQ, WK, TYPE, VAL, MATE,
    newState, setupStart, cloneState, fromFEN, toFEN, posKeyFull,
    attacked, inCheck, genPseudo, genLegal, makeMove, unmakeMove, evaluate,
    search, perft,
  };
});
