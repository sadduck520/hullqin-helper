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
  let settings = HQ.loadSettings('gjxAI', DEFAULTS);
  const saveSettings = () => HQ.saveSettings('gjxAI', settings);

  const LEVELS = {
    1: { d: 1, t: 60, cp: 500 }, 2: { d: 2, t: 80, cp: 300 }, 3: { d: 2, t: 120, cp: 180 },
    4: { d: 3, t: 180, cp: 100 }, 5: { d: 4, t: 260, cp: 50 }, 6: { d: 4, t: 350, cp: 25 },
    7: { d: 5, t: 450, cp: 10 }, 8: { d: 6, t: 650, cp: 0 }, 9: { d: 7, t: 900, cp: 0 },
    10: { d: 99, t: 1300, cp: 0 },
  };
  const levelName = lv => lv <= 2 ? '新手' : lv <= 4 ? '进阶' : lv <= 6 ? '高手' : lv <= 8 ? '大师' : '特级大师';

  /* ---------------- React fiber 工具（公共模块 hullqin-shared） ---------------- */
  const walkProps = HQ.findProps;

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

  /* ---------------- 走子执行（模拟点击，公共模块） ---------------- */
  const clickEl = HQ.clickEl, sleep = HQ.sleep;

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

  /* ---------------- 高亮层（公共模块） ---------------- */
  let overlay = null, overlaySvg = null;
  function ensureOverlay(svg) {
    if (overlay && overlaySvg === svg && document.contains(overlay)) { overlay.__fit(); return overlay; }
    if (overlay) overlay.remove();
    overlaySvg = svg;
    overlay = HQ.createOverlay(svg, '-42,-42,84,84');
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
  function clearHighlight() { if (overlay) HQ.clearOverlay(overlay); }

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
  const toast = msg => HQ.toast(msg, 'gjx-ai-toast');

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
    #gjxAI{width:252px;background:rgba(13,20,33,.94);
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

  function buildPanel(container) {
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
    (container || document.body).appendChild(p);
    panelEl = p;

    // 拖动（公共模块）
    
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

  /* ---------------- 注册（壳负责挂载与调度） ---------------- */
  HQ.registerGame({
    id: 'gjx', name: '国际象棋', icon: '♞', interval: 450, dragIgnore: 'mini',
    route: /\/gjxq/,
    mount(container) {
      buildPanel(container);
      return p.querySelector('.hd');
    },
    tick: () => tick(),
  });
  console.log('[国象AI] 已注册 ✓');

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
