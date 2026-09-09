// ==UserScript==
// @name         国际象棋 AI 助手（game.hullqin.cn）
// @namespace    gjx-ai-helper
// @version      1.0.0
// @description  桌游合集国际象棋的 AI 助手：双引擎（Stockfish 世界级 / 自研轻量）+ 1~10 难度可调 + 💡提示 + 🤖自动代走 + 评估条。朋友间娱乐使用。
// @author       Eve
// @match        https://game.hullqin.cn/*
// @run-at       document-idle
// @grant        none
// @connect      cdn.jsdelivr.net
// @license      MIT
// ==/UserScript==
(function () {
/**
 * Stockfish Worker 加载器（路线 A）
 * 从 jsdelivr CDN 拉取 stockfish@10.0.2（wasm 版），打补丁后以 Blob Worker 运行
 * - 官方胶水只认 STOCKFISH(wasmPath) 参数，blob worker 拿不到 hash，
 *   所以把 wasm 做成 blob URL、替换自动初始化调用注入进去
 * - 暴露 UCI 接口：send(cmd) / onLine(fn) / quit()
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SFLoader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/';

  // 带进度的 fetch
  function fetchProg(url, onProg) {
    return fetch(url).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const len = +res.headers.get('content-length') || 0;
      if (!res.body || !len) return res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks = [];
      let recv = 0;
      function pump() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            const out = new Uint8Array(recv);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            return out.buffer;
          }
          recv += value.length;
          chunks.push(value);
          if (onProg) onProg(recv / len);
          return pump();
        });
      }
      return pump();
    });
  }

  function bytesToB64(buf) {
    const u8 = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /**
   * 加载引擎，resolve 出 {send, onLine, destroy}
   * onProgress: 0~1 的下载进度回调
   */
  function load(onProgress) {
    return new Promise((resolve, reject) => {
      let glueP = fetchProg(CDN + 'stockfish.js', onProgress ? p => onProgress(p * 0.12) : null)
        .then(b => new TextDecoder().decode(b));
      let wasmP = fetchProg(CDN + 'stockfish.wasm', onProgress ? p => onProgress(0.12 + p * 0.88) : null);
      Promise.all([glueP, wasmP]).then(([glue, wasmBuf]) => {
        try {
          const TARGET = 'stockfish=STOCKFISH()';
          if (!glue.includes(TARGET)) throw new Error('胶水代码格式已变化，无法注入 wasm');
          const wasmUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));
          const patched = glue.replace(TARGET, 'stockfish=STOCKFISH("' + wasmUrl + '")');
          const worker = new Worker(URL.createObjectURL(new Blob([patched], { type: 'application/javascript' })));
          const api = {
            _listeners: [],
            send(cmd) { worker.postMessage(cmd); },
            onLine(fn) { this._listeners.push(fn); },
            destroy() { try { worker.terminate(); } catch (e) { } },
          };
          worker.onmessage = e => {
            const text = '' + e.data;
            for (const line of text.split('\n')) {
              const t = line.trim();
              if (t) for (const fn of api._listeners) fn(t);
            }
          };
          worker.onerror = e => reject(new Error('SF worker: ' + (e.message || '未知错误')));
          let done = false;
          api.onLine(line => {
            if (!done && line === 'uciok') { done = true; resolve(api); }
          });
          setTimeout(() => { if (!done) { done = true; resolve(api); } }, 12000); // 兜底
          worker.postMessage('uci');
        } catch (err) { reject(err); }
      }).catch(reject);
    });
  }

  return { load };
});

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

/* ============================================================
 * 页面桥接 + UI（chess.core 引擎与 SFLoader 由 build 注入）
 * ============================================================ */
(function () {
  'use strict';
  const E = (typeof ChessEngine !== 'undefined' && ChessEngine) || self.ChessEngine;
  const SF = (typeof SFLoader !== 'undefined' && SFLoader) || self.SFLoader;
  if (!E || !SF) { console.error('[国象AI] 组件缺失'); return; }
  if (self.__gjxAIInjected) return;
  self.__gjxAIInjected = true;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const DEAD = 127;
  const SITE_TYPE = { K: 0, Q: 1, R: 2, B: 3, N: 4, P: 5 };   // site type
  const TYPE_CHAR = ['K', 'Q', 'R', 'B', 'N', 'P'];            // site type -> 字母
  const CN_NAME = { Q: '后', R: '车', B: '象', N: '马' };        // 升变显示
  const FILES = 'abcdefgh';

  /* ---------------- 设置 ---------------- */
  const DEFAULTS = { engine: 'own', level: 6, hint: true, auto: false, autoWhite: false, autoBlack: false };
  let settings = { ...DEFAULTS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('gjxAI') || '{}')); } catch (e) { }
  const saveSettings = () => { try { localStorage.setItem('gjxAI', JSON.stringify(settings)); } catch (e) { } };

  const LEVELS = {
    1: { d: 1, t: 60, cp: 500 }, 2: { d: 2, t: 80, cp: 300 }, 3: { d: 2, t: 120, cp: 180 },
    4: { d: 3, t: 180, cp: 100 }, 5: { d: 4, t: 260, cp: 50 }, 6: { d: 4, t: 350, cp: 25 },
    7: { d: 5, t: 450, cp: 10 }, 8: { d: 6, t: 650, cp: 0 }, 9: { d: 7, t: 900, cp: 0 },
    10: { d: 99, t: 1300, cp: 0 },
  };
  const levelName = lv => lv <= 2 ? '新手' : lv <= 4 ? '进阶' : lv <= 6 ? '高手' : lv <= 8 ? '大师' : '特级大师';

  /* ---------------- React fiber 工具 ---------------- */
  function getFiber(el) {
    for (const k in el) if (k.indexOf('__reactFiber') === 0) return el[k];
    return null;
  }
  function walkProps(el, test, maxHop) {
    let f = getFiber(el);
    for (let h = 0; f && h <= (maxHop || 6); h++) {
      const p = f.memoizedProps;
      if (p && test(p)) return p;
      f = f.return;
    }
    return null;
  }

  /* ---------------- 页面读取 ---------------- */
  function getBoardSvg() {
    for (const s of document.querySelectorAll('svg')) {
      const vb = (s.getAttribute('viewBox') || '').trim();
      if (vb === '-42,-42,84,84') return s;
    }
    return null;
  }

  // 顶部组件 fiber: {reverse, finish, board:{isWhiteTurn,pieces}, records, legalMoves, setPRB, step}
  function readState() {
    const svg = getBoardSvg();
    if (!svg) return null;
    let top = null;
    const anyEl = svg.querySelector('text') || svg.querySelector('rect');
    // 本地模式: {board:{pieces,isWhiteTurn}, finish, legalMoves,...}
    // 联机模式: {pieces, state, isWhite, isMyTurn, legalMoves,...}（无 board 字段！）
    if (anyEl) top = walkProps(anyEl, p => p && ((p.board && p.board.pieces) || Array.isArray(p.pieces)) && p.legalMoves !== undefined, 8);
    if (!top) return null;
    const pieces = top.board ? top.board.pieces : top.pieces;
    if (!pieces) return null;
    // 终局状态：本地用 finish，联机用 state（枚举一致 0等待白 1等待黑 2白胜 3黑胜 4/5悔棋）
    const finish = top.finish !== undefined ? top.finish : (top.state !== undefined ? top.state : 0);
    const isWhiteTurn = top.board ? !!top.board.isWhiteTurn
      : (top.state !== undefined ? top.state === 0 : (top.isMyTurn ? !!top.isWhite : true));
    return {
      svg,
      pieces,                            // [{pos, type, moved}] id = 下标, pos 127 = 被吃
      isWhiteTurn,
      legalMoves: top.legalMoves,        // {pieceId: [toPos...]}
      records: top.records || [],
      finish,
      reverse: !!top.reverse,
      myWhite: top.isWhite !== undefined ? !!top.isWhite : null,   // 联机：我的阵营
    };
  }

  function parseStatus(myWhiteFiber) {
    // 优先读游戏状态元素（.text-xl），避免扫到面板自己的文字
    let text = '';
    document.querySelectorAll('.text-xl').forEach(e => { text += e.textContent + '\n'; });
    if (!/白|黑/.test(text)) text = document.body ? (document.body.innerText || '') : '';
    let m = text.match(/(白|黑)方胜利/);
    if (m) return { over: true, winnerWhite: m[1] === '白' };
    if (/被将死/.test(text)) return { over: true, winnerWhite: null };   // 「玩家X被将死了，只能认输」格式
    if (/恭喜获胜|你胜利/.test(text)) return { over: true, winnerWhite: null };
    m = text.match(/你是(白|黑)方/);
    const myWhite = m ? m[1] === '白' : (myWhiteFiber !== undefined && myWhiteFiber !== null ? myWhiteFiber : null);
    if (/等你下棋/.test(text) && myWhite !== null) return { over: false, myWhite, turnWhite: myWhite };
    m = text.match(/[等请](白|黑)方下棋/);
    if (m) return { over: false, myWhite, turnWhite: m[1] === '白' };
    return { over: false, myWhite, turnWhite: null };
  }

  /* ---------------- FEN 生成（喂给引擎） ---------------- */
  function stateToFEN(st) {
    const CHAR = { 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };
    const board = new Array(64).fill(0);
    for (let i = 0; i < st.pieces.length; i++) {
      const p = st.pieces[i];
      if (p.pos >= 64) continue;
      const code = 6 - p.type;                     // site K0..P5 -> 引擎 K6..P1
      board[p.pos] = i < 16 ? code : code + 8;
    }
    let rows = [];
    for (let y = 0; y < 8; y++) {
      let row = '', run = 0;
      for (let x = 0; x < 8; x++) {
        const c = board[y * 8 + x];
        if (!c) { run++; continue; }
        if (run) { row += run; run = 0; }
        const t = CHAR[c > 8 ? c - 8 : c];
        row += c > 8 ? t.toLowerCase() : t;
      }
      if (run) row += run;
      rows.push(row);
    }
    // 易位权：王/车动过即失去
    const alive = i => st.pieces[i] && st.pieces[i].pos < 64;
    const unmoved = i => alive(i) && !st.pieces[i].moved;
    let castle = '';
    if (unmoved(0) && unmoved(2)) castle += 'K';
    if (unmoved(0) && unmoved(3)) castle += 'Q';
    if (unmoved(16) && unmoved(19)) castle += 'k';
    if (unmoved(16) && unmoved(18)) castle += 'q';
    // 过路兵：最后一步是兵直进两格
    let ep = '-';
    const last = st.records[0];
    if (last) {
      const p = st.pieces[last.id];
      if (p && p.type === 5 && Math.abs(last.after - last.before) === 16) {
        const sq = (last.before + last.after) / 2;
        ep = FILES[sq % 8] + (8 - (sq >> 3));
      }
    }
    // 半回合数：从最近往前数到吃子/动兵/升变
    let half = 0;
    for (const r of st.records) {
      const pc = st.pieces[r.id];
      if ((r.eat != null && r.eat !== false) || r.sp != null || (pc && pc.type === 5)) break;
      half++;
    }
    return rows.join('/') + ' ' + (st.isWhiteTurn ? 'w' : 'b') + ' ' + (castle || '-') + ' ' + ep + ' ' + half + ' ' + (Math.floor(st.records.length / 2) + 1);
  }

  const sqName = pos => FILES[pos % 8] + (8 - (pos >> 3));

  /* ---------------- 引擎管理 ---------------- */
  const engine = {
    sf: null, sfLoading: null,
    ensureSF() {
      if (this.sf) return Promise.resolve(this.sf);
      if (!this.sfLoading) {
        setInfo('⏳ 下载 Stockfish 引擎…');
        this.sfLoading = SF.load(p => setInfo('⏳ 下载 Stockfish 引擎 ' + Math.round(p * 100) + '%'))
          .then(sf => { setInfo('✅ 引擎就绪'); return this.sf = sf; })
          .catch(err => { toast('Stockfish 加载失败，已回退自研引擎'); settings.engine = 'own'; saveSettings(); renderPanel(); return this.sfLoading = null; throw err; });
      }
      return this.sfLoading;
    },
    // 统一入口：返回 Promise<{from,to,promoSiteType,scoreCp(白视角),depth}>
    async think(fen, turnWhite) {
      const lv = settings.level, prof = LEVELS[lv];
      if (settings.engine === 'sf') {
        const sf = await this.ensureSF();
        sf.send('setoption name Skill Level value ' + Math.round((lv - 1) * 20 / 9));
        sf.send('position fen ' + fen);
        sf.send('go movetime ' + (100 + lv * 65));
        return await new Promise((resolve, reject) => {
          let score = null, depth = 0, timer = setTimeout(() => { cleanup(); reject(new Error('SF 超时')); }, 15000);
          const on = line => {
            if (line.indexOf('info ') === 0) {
              const dm = line.match(/ depth (\d+)/), sm = line.match(/score (cp|mate) (-?\d+)/);
              if (dm) depth = +dm[1];
              if (sm) score = sm[1] === 'mate' ? (sm[2] > 0 ? 10000 : -10000) : +sm[2];
            } else if (line.indexOf('bestmove') === 0) {
              clearTimeout(timer); cleanup();
              const mv = line.split(' ')[1];
              if (!mv || mv === '(none)') return resolve(null);
              const from = FILES.indexOf(mv[0]) + (8 - +mv[1]) * 8;
              const to = FILES.indexOf(mv[2]) + (8 - +mv[3]) * 8;
              const promoChar = mv[4];
              const promoType = promoChar ? { q: 1, r: 2, b: 3, n: 4 }[promoChar] : 0;
              const cpW = score === null ? 0 : (turnWhite ? score : -score);
              resolve({ from, to, promoType, scoreCp: cpW, depth });
            }
          };
          const cleanup = () => sf.onLine && (sf._listeners = sf._listeners.filter(f => f !== on));
          sf.onLine(on);
        });
      }
      // 自研引擎
      const s = E.fromFEN(fen);
      const r = E.search(s, { maxDepth: prof.d, timeMs: prof.t, avoid: history.slice(-12) });
      if (!r.move) return null;
      let pick = { from: r.move.from, to: r.move.to, promoType: r.move.promo ? 6 - r.move.promo : 0, scoreCp: (turnWhite ? 1 : -1) * r.score, depth: r.depth };
      if (prof.cp > 0 && r.root && r.root.length > 1) {
        const cand = r.root.filter(x => (turnWhite ? 1 : -1) * x.sc >= r.score - prof.cp);
        const chosen = cand[Math.floor(Math.random() * cand.length)];
        if (chosen) pick = { from: chosen.m.from, to: chosen.m.to, promoType: chosen.m.promo ? 6 - chosen.m.promo : 0, scoreCp: (turnWhite ? 1 : -1) * chosen.sc, depth: r.depth };
      }
      return pick;
    },
  };

  /* ---------------- 走子执行（模拟点击） ---------------- */
  function clickEl(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: self })); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function readHints(svg) {
    const list = [];
    for (const g of svg.querySelectorAll('g.gjxq-piece-hover-select')) {
      const use = g.querySelector('use');
      if (!use) continue;
      const p = walkProps(use, pp => pp && typeof pp.pos === 'number', 3);
      if (p) list.push({ pos: p.pos, el: use, needPromotion: !!p.needPromotion, el: use });
    }
    return list;
  }

  function hintsMatch(list, targets) {
    if (!targets || !list.length || list.length !== targets.length) return false;
    const set = new Set(targets);
    for (const h of list) if (!set.has(h.pos)) return false;
    return true;
  }

  function findPieceRect(st, pieceId) {
    for (const rect of st.svg.querySelectorAll('rect')) {
      const p = walkProps(rect, pp => pp && pp.id === pieceId && typeof pp.pos === 'number', 3);
      if (p && p.pos === st.pieces[pieceId].pos) {
        if (rect.onclick) return rect;              // DOM onclick 才是真实可点性（fiber 的 onClick 在联机下不可靠）
        return null;                                 // 找到棋子但不可点（非该方回合）
      }
    }
    return null;
  }

  async function playMove(st, pieceId, to, promoType) {
    const piece = st.pieces[pieceId];
    if (!piece || piece.pos >= 64) return false;
    const rect = findPieceRect(st, pieceId);
    if (!rect) return false;                        // 不可点（非该方回合）
    let hints = readHints(st.svg);
    const targets = st.legalMoves[pieceId] || [];
    if (!hintsMatch(hints, targets)) {
      clickEl(rect);
      const deadline = Date.now() + 1500;
      let ok = false;
      while (Date.now() < deadline) {
        await sleep(70);
        const s2 = readState();
        if (!s2) return false;
        hints = readHints(s2.svg);
        if (hintsMatch(hints, s2.legalMoves[pieceId] || [])) { ok = true; break; }
      }
      if (!ok) return false;
    }
    const cell = hints.find(h => h.pos === to);
    if (!cell) return false;
    clickEl(cell.el);
    if (promoType) {
      // 弹出四选一：点击对应的圆圈（后=大圈 r=3，其余小圈按偏移定位）
      const deadline = Date.now() + 1500;
      let clicked = false;
      while (Date.now() < deadline && !clicked) {
        await sleep(80);
        const s2 = readState();
        if (!s2) return false;
        const cx = 10 * (s2.reverse ? 7 - (to % 8) : to % 8) - 35;
        const cy = 10 * (s2.reverse ? 7 - (to >> 3) : to >> 3) - 35;
        const offs = { 1: [0, 1.7], 2: [-3.25, -3], 3: [0, -3], 4: [3.25, -3] };
        const off = offs[promoType] || [0, 1.7];
        for (const c of s2.svg.querySelectorAll('circle[fillopacity="0"], circle[fill-opacity="0"]')) {
          if (+c.getAttribute('cx') === +(cx + off[0]).toFixed(2) && +c.getAttribute('cy') === +(cy + off[1]).toFixed(2)) {
            clickEl(c); clicked = true; break;
          }
        }
      }
      if (!clicked) return false;
    }
    return true;
  }

  /* ---------------- 高亮层 ---------------- */
  let overlay = null, overlaySvg = null;
  function ensureOverlay(svg) {
    if (overlay && overlaySvg === svg && document.contains(overlay)) { overlay.__fit(); return overlay; }
    if (overlay) overlay.remove();
    overlaySvg = svg;
    overlay = document.createElementNS(SVGNS, 'svg');
    overlay.setAttribute('viewBox', '-42,-42,84,84');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:9998;';
    overlay.__fit = () => {
      const r = svg.getBoundingClientRect();
      overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
    };
    overlay.__fit();
    document.body.appendChild(overlay);
    return overlay;
  }
  function sqXY(pos, reverse) {
    const col = pos % 8, row = pos >> 3;
    return reverse ? [10 * (7 - col) - 35, 10 * (7 - row) - 35] : [10 * col - 35, 10 * row - 35];
  }
  function drawHighlight(svg, reverse, from, to, promo) {
    const ov = ensureOverlay(svg);
    while (ov.firstChild) ov.removeChild(ov.firstChild);
    const mk = (pos, color) => {
      const [cx, cy] = sqXY(pos, reverse);
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', cx - 4.7); r.setAttribute('y', cy - 4.7);
      r.setAttribute('width', 9.4); r.setAttribute('height', 9.4);
      r.setAttribute('rx', 1.2);
      r.setAttribute('fill', color.fill);
      r.setAttribute('stroke', color.stroke);
      r.setAttribute('stroke-width', 0.9);
      r.setAttribute('opacity', '0.9');
      return r;
    };
    ov.appendChild(mk(from, { fill: 'rgba(245,158,11,.25)', stroke: '#f59e0b' }));
    ov.appendChild(mk(to, { fill: promo ? 'rgba(168,85,247,.3)' : 'rgba(34,197,94,.25)', stroke: promo ? '#a855f7' : '#22c55e' }));
  }
  function clearHighlight() { if (overlay) { overlay.remove(); overlay = null; overlaySvg = null; } }

  addEventListener('scroll', () => { if (overlay && overlaySvg) overlay.__fit(); }, { passive: true });
  addEventListener('resize', () => { if (overlay && overlaySvg) overlay.__fit(); });

  /* ---------------- 主循环 ---------------- */
  const history = [];          // 重复规避（FEN 前4段）
  let hintCache = { key: '', result: null };
  let busy = false;
  let stuckKey = null;   // 将死软锁的局面（网站有时不判负）
  const dbg = { ticks: 0, autoAttempts: 0, playOk: 0, playFail: 0, lastFail: '', lastThinkMs: 0 };
  let lastInfo = '';

  function setInfo(text) {
    if (lastInfo === text) return;
    lastInfo = text;
    const el = panelEl && panelEl.querySelector('.info');
    if (el) el.textContent = text;
  }
  function toast(msg) {
    let t = document.querySelector('.gjx-ai-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'gjx-ai-toast';
      t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;background:rgba(15,23,42,.92);color:#e2e8f0;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  function fenKey(st) { return stateToFEN(st).split(' ').slice(0, 4).join(' '); }

  async function tick() {
    // 路由门禁：只在国际象棋页面激活（避免与斗兽棋等其他脚本面板互相叠加）
    const onRoute = /\/gjxq/.test(location.pathname);
    if (panelEl) panelEl.style.display = onRoute ? '' : 'none';
    if (!onRoute) { clearHighlight(); return; }
    dbg.ticks++;
    if (busy) return;
    const st = readState();
    if (!st) { clearHighlight(); setInfo('等待对局开始…（进入本地对战或房间开局后自动工作）'); return; }
    const stat = parseStatus(st ? st.myWhite : undefined);
    // 文字信号优先（本地模式 finish 字段可能滞后），finish 字段作兜底
    const over = stat.over || st.finish === 2 || st.finish === 3;
    if (over) {
      clearHighlight();
      const whiteWon = stat.over ? stat.winnerWhite !== false : st.finish === 2;
      setInfo(whiteWon === false && stat.winnerWhite === null ? '🎉 获胜' : whiteWon ? '🎉 白方胜利' : '🎉 黑方胜利');
      return;
    }
    if (st.finish === 4 || st.finish === 5 || stat.turnWhite === null) { setInfo('等待中（悔棋请求/未知状态）'); return; }
    if (stuckKey) {
      if (fenKey(st) === stuckKey) { setInfo('将死/逼和 — 请手动开新局'); return; }
      stuckKey = null;   // 局面变化（新局/悔棋），恢复
    }

    // ---- 提示模式 ----
    if (settings.hint) {
      const key = fenKey(st) + '|' + settings.engine + '|' + settings.level;
      if (hintCache.key !== key) {
        hintCache.key = key; hintCache.result = null;
        try {
          const fen = stateToFEN(st);
          const r = await engine.think(fen, st.isWhiteTurn);
          const st3 = readState();                      // 局面未变才缓存
          if (st3 && fenKey(st3) === fenKey(st)) hintCache.result = r;
        } catch (err) { setInfo('❌ ' + err.message); }
      }
      const r = hintCache.result;
      if (r) {
        drawHighlight(st.svg, st.reverse, r.from, r.to, r.promoType);
        const pawns = r.scoreCp / 100;
        const desc = pawns > 0.15 ? '白优' : pawns < -0.15 ? '黑优' : '均势';
        setInfo(`最佳: ${sqName(r.from)}→${sqName(r.to)}${r.promoType ? ' 升' + CN_NAME[TYPE_CHAR[r.promoType]] : ''} | ${desc} ${pawns > 0 ? '+' : ''}${pawns.toFixed(1)} | 深度${r.depth || '?'}`);
        updateEvalBar(r.scoreCp);
      }
    } else {
      clearHighlight();
    }

    // ---- 自动模式 ----
    const mySide = stat.myWhite !== null && stat.myWhite !== undefined ? stat.myWhite : st.myWhite;
    const autoSide = mySide !== null && mySide !== undefined ? (mySide ? 'white' : 'black')
      : (settings.autoWhite && settings.autoBlack ? 'both' : settings.autoWhite ? 'white' : settings.autoBlack ? 'black' : null);
    const shouldAuto = settings.auto && autoSide && (autoSide === 'both' || (autoSide === 'white') === st.isWhiteTurn);
    if (shouldAuto) {
      dbg.autoAttempts++;
      busy = true;
      try {
        await sleep(500 + Math.random() * 1000);
        const s2 = readState();
        const st2 = parseStatus(s2 ? s2.myWhite : undefined);
        // finish 语义：本地=布尔，联机=状态枚举(0等待白 1等待黑 2白胜 3黑胜)。只拦真实的胜负态
        const finished = s2.finish === true || s2.finish === 2 || s2.finish === 3;
        if (!s2 || finished || st2.over || (st2.turnWhite !== null && st2.turnWhite !== s2.isWhiteTurn)) return;
        const key2 = fenKey(s2) + '|' + settings.engine + '|' + settings.level;
        let r;
        if (hintCache.key === key2 && hintCache.result) r = hintCache.result;   // 与提示共用计算
        else {
          try { r = await engine.think(stateToFEN(s2), s2.isWhiteTurn); }
          catch (err) { setInfo('❌ ' + err.message); console.error('[国象AI]', err); return; }
        }
        if (!r) {
          // 引擎无棋可走：将死/逼和。网站有时不判负（finish 仍为 0），停下来等人处理
          setInfo((s2.isWhiteTurn ? '黑方' : '白方') + '将死/逼和 — 网站未判负，请手动开新局');
          clearHighlight();
          stuckKey = fenKey(s2);
          return;
        }
        // 定位走子棋子（id = pieces 下标），并确认该方可点击（联机非我方回合时无 onClick）
        let pieceId = -1;
        for (let i = 0; i < s2.pieces.length; i++) {
          const p = s2.pieces[i];
          if (p.pos === r.from && p.pos < 64 && (i < 16) === s2.isWhiteTurn) { pieceId = i; break; }
        }
        if (pieceId < 0) return;
        if (!findPieceRect(s2, pieceId)) return;   // 不可点（例如联机对方回合）
        const ok = await playMove(s2, pieceId, r.to, r.promoType);
        if (ok) dbg.playOk++; else { dbg.playFail++; dbg.lastFail = 'pieceId=' + pieceId + ' to=' + r.to + ' clickable=' + !!findPieceRect(s2, pieceId); }
        if (ok) {
          history.push(fenKey(s2));
          if (history.length > 40) history.shift();
        }
      } catch (err) {
        console.error('[国象AI]', err);
        setInfo('❌ ' + err.message);
      } finally { busy = false; }
    }
  }

  function updateEvalBar(cpWhite) {
    if (!panelEl) return;
    const bar = panelEl.querySelector('.evalbar-fill');
    const txt = panelEl.querySelector('.evalbar-text');
    if (!bar) return;
    const frac = 1 / (1 + Math.exp(-cpWhite / 400));    // 0~1，白方占比
    bar.style.width = (frac * 100).toFixed(1) + '%';
    const p = cpWhite / 100;
    txt.textContent = (p > 0 ? '+' : '') + p.toFixed(1);
    txt.style.color = p >= 0 ? '#f8fafc' : '#94a3b8';
  }

  /* ---------------- UI 面板 ---------------- */
  let panelEl = null;
  const CSS = `
    #gjxAI{position:fixed;top:10px;right:10px;z-index:99999;width:252px;background:rgba(13,20,33,.94);
      color:#e2e8f0;border:1px solid rgba(148,163,184,.25);border-radius:14px;font-size:12px;
      box-shadow:0 8px 28px rgba(0,0,0,.4);user-select:none;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;}
    #gjxAI .hd{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;cursor:move;}
    #gjxAI .hd .ttl{font-size:13.5px;font-weight:700;letter-spacing:.5px;}
    #gjxAI .bd{padding:0 12px 12px;}
    #gjxAI .engines{display:flex;gap:6px;margin-bottom:10px;}
    #gjxAI .eng-card{flex:1;border:1px solid rgba(148,163,184,.3);border-radius:9px;padding:7px 6px;text-align:center;cursor:pointer;transition:all .15s;}
    #gjxAI .eng-card:hover{border-color:rgba(148,163,184,.6);}
    #gjxAI .eng-card.on{border-color:#6366f1;background:rgba(99,102,241,.16);}
    #gjxAI .eng-card .nm{font-weight:600;font-size:12px;}
    #gjxAI .eng-card .sub{font-size:10px;color:#94a3b8;margin-top:2px;}
    #gjxAI .row{display:flex;align-items:center;justify-content:space-between;margin:9px 0 4px;}
    #gjxAI .lbl{color:#cbd5e1;}
    #gjxAI .lv{color:#fbbf24;font-weight:700;}
    #gjxAI input[type=range]{width:100%;accent-color:#6366f1;cursor:pointer;margin:2px 0 0;}
    #gjxAI .modes{display:flex;gap:6px;margin-top:9px;}
    #gjxAI .mode{flex:1;text-align:center;padding:6px 0;border:1px solid rgba(148,163,184,.3);border-radius:8px;cursor:pointer;font-size:12px;transition:all .15s;}
    #gjxAI .mode.on{border-color:#22c55e;background:rgba(34,197,94,.15);color:#4ade80;}
    #gjxAI .sides{display:flex;gap:12px;margin-top:7px;font-size:11.5px;color:#cbd5e1;}
    #gjxAI .sides label{display:flex;align-items:center;gap:4px;cursor:pointer;}
    #gjxAI .evalwrap{margin-top:10px;}
    #gjxAI .evalbar{height:8px;border-radius:5px;background:#1e293b;overflow:hidden;position:relative;}
    #gjxAI .evalbar-fill{height:100%;background:linear-gradient(90deg,#e2e8f0,#94a3b8);width:50%;transition:width .4s;}
    #gjxAI .evalbar-mid{position:absolute;left:50%;top:-1px;bottom:-1px;width:1px;background:#475569;}
    #gjxAI .evalbar-text{font-size:10.5px;color:#94a3b8;margin-top:3px;text-align:right;}
    #gjxAI .info{margin-top:8px;font-size:11px;color:#94a3b8;line-height:1.5;min-height:17px;word-break:break-all;}
    #gjxAI .mini{cursor:pointer;opacity:.6;font-size:14px;padding:0 4px;}
    #gjxAI .mini:hover{opacity:1;}
    #gjxAI.min{width:44px!important;}
    #gjxAI.min .bd{display:none;}
    #gjxAI.min{background:rgba(13,20,33,.8);}
  `;

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const p = document.createElement('div');
    p.id = 'gjxAI';
    p.innerHTML = `
      <div class="hd"><span class="ttl">♞ 国象 AI 助手</span><span class="mini">—</span></div>
      <div class="bd">
        <div class="engines">
          <div class="eng-card" data-e="sf"><div class="nm">🏆 Stockfish</div><div class="sub">世界级开源引擎</div></div>
          <div class="eng-card" data-e="own"><div class="nm">🛠 自研</div><div class="sub">轻量·秒开</div></div>
        </div>
        <div class="row"><span class="lbl">难度</span><span class="lv">${settings.level} · ${levelName(settings.level)}</span></div>
        <input type="range" min="1" max="10" step="1" value="${settings.level}">
        <div class="modes">
          <div class="mode" data-m="hint">💡 提示</div>
          <div class="mode" data-m="auto">🤖 自动</div>
        </div>
        <div class="sides">
          <label><input type="checkbox" data-s="autoWhite"> 白方AI</label>
          <label><input type="checkbox" data-s="autoBlack"> 黑方AI</label>
        </div>
        <div class="evalwrap">
          <div class="evalbar"><div class="evalbar-fill"></div><div class="evalbar-mid"></div></div>
          <div class="evalbar-text">±0.0</div>
        </div>
        <div class="info">等待对局…</div>
      </div>`;
    document.body.appendChild(p);
    panelEl = p;

    // 拖动
    const hd = p.querySelector('.hd');
    let dragging = null;
    hd.addEventListener('mousedown', e => {
      if (e.target.classList.contains('mini')) return;
      const r = p.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    addEventListener('mousemove', e => {
      if (!dragging) return;
      p.style.left = (e.clientX - dragging.dx) + 'px';
      p.style.top = (e.clientY - dragging.dy) + 'px';
      p.style.right = 'auto';
    });
    addEventListener('mouseup', () => dragging = null);

    // 收起
    p.querySelector('.mini').addEventListener('click', () => {
      p.classList.toggle('min');
      p.querySelector('.mini').textContent = p.classList.contains('min') ? '♞' : '—';
    });

    // 引擎卡片
    p.querySelectorAll('.eng-card').forEach(c => c.addEventListener('click', () => {
      settings.engine = c.dataset.e;
      hintCache = { key: '', result: null };
      saveSettings(); renderPanel();
      if (settings.engine === 'sf') engine.ensureSF().catch(() => renderPanel());
    }));

    // 难度
    const range = p.querySelector('input[type=range]');
    range.addEventListener('input', () => {
      settings.level = +range.value;
      hintCache = { key: '', result: null };
      saveSettings(); renderPanel();
    });

    // 模式
    p.querySelectorAll('.mode').forEach(m => m.addEventListener('click', () => {
      const k = m.dataset.m;
      settings[k] = !settings[k];
      saveSettings(); renderPanel();
    }));

    // 阵营
    p.querySelectorAll('input[type=checkbox]').forEach(c => c.addEventListener('change', () => {
      settings[c.dataset.s] = c.checked;
      saveSettings(); renderPanel();
    }));

    renderPanel();
  }

  function renderPanel() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.eng-card').forEach(c => c.classList.toggle('on', c.dataset.e === settings.engine));
    panelEl.querySelectorAll('.mode').forEach(m => m.classList.toggle('on', !!settings[m.dataset.m]));
    const range = panelEl.querySelector('input[type=range]');
    if (+range.value !== settings.level) range.value = settings.level;
    panelEl.querySelector('.lv').textContent = settings.level + ' · ' + levelName(settings.level);
    panelEl.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = !!settings[c.dataset.s]; });
  }

  /* ---------------- 启动 ---------------- */
  function start() {
    buildPanel();
    setInterval(tick, 450);
    console.log('[国象AI] 已加载 ✓');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* ---------------- 调试接口 ---------------- */
  self.__gjxAI = {
    readState, parseStatus, stateToFEN,
    think: (fen, w) => engine.think(fen, w),
    loadSF: () => engine.ensureSF(),
    getSF: () => engine.sf,
    settings, cache: () => hintCache, dbg,
    setAuto: (w, b) => { settings.auto = true; settings.autoWhite = !!w; settings.autoBlack = !!b; saveSettings(); },
  };
})();

})();
