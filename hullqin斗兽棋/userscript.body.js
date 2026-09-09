/* ============================================================
 * 页面桥接 + UI（引擎部分由 build 脚本注入，暴露为 DSQEngine）
 * ============================================================ */
(function () {
  'use strict';
  const E = (typeof DSQEngine !== 'undefined' && DSQEngine) || window.DSQEngine;
  if (!E) { console.error('[斗兽棋AI] 引擎未加载'); return; }
  if (window.__dsqAIInjected) return;
  window.__dsqAIInjected = true;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const RED = 0, GREEN = 1;
  const S = E.NAMES, EM = E.EMOJI;

  /* ---------------- 设置 ---------------- */
  const DEFAULTS = { hint: true, auto: false, autoRed: false, autoGreen: false, time: 600, depth: 0 };
  let settings = HQ.loadSettings('dsqAI', DEFAULTS);
  const saveSettings = () => HQ.saveSettings('dsqAI', settings);

  /* ---------------- React fiber 工具（公共模块 hullqin-shared） ---------------- */
  const findProps = HQ.findProps;

  /* ---------------- 页面读取 ---------------- */
  function getBoardSvg() {
    for (const s of document.querySelectorAll('svg')) {
      const vb = (s.getAttribute('viewBox') || '').trim().replace(/\s+/g, ',');
      if (vb !== '-40,-50,80,100') continue;
      for (const u of s.querySelectorAll('use')) {
        const href = u.getAttribute('href') || u.getAttribute('xlink:href');
        if (href === '#piece-red' || href === '#piece-green') return s;
      }
    }
    return null;
  }

  // 读取 16 个棋子：p.Z 渲染常规棋子（fiber: {id,pos,onClick}），v.Z 渲染最后移动动画（fiber: {id,before,after}）
  function readPieces(svg) {
    const pieces = {};
    let isRedView = null;
    for (const rect of svg.querySelectorAll('rect')) {
      const p = findProps(rect, pp => pp && typeof pp.id === 'number' && typeof pp.pos === 'number', 4);
      if (p) {
        pieces[p.id] = { id: p.id, pos: p.pos, clickable: !!p.onClick, el: rect };
        if (isRedView === null) isRedView = !!p.isRedView;
      }
    }
    for (const g of svg.querySelectorAll('g')) {
      const p = findProps(g, pp => pp && typeof pp.id === 'number' && typeof pp.before === 'number' && typeof pp.after === 'number', 3);
      if (p && !pieces[p.id]) {
        pieces[p.id] = { id: p.id, pos: p.after, clickable: false, el: g };
        if (isRedView === null) isRedView = !p.reverse;
      }
    }
    return { pieces, isRedView };
  }

  // 读取"可选目标格"提示（h.Z: <g class=cursor-pointer onClick><use #piece-select/></g>）
  function readHints(svg) {
    const map = new Map();
    for (const g of svg.querySelectorAll('g.cursor-pointer')) {
      const p = findProps(g, pp => pp && typeof pp.position === 'number' && pp.onClick, 3);
      if (p) map.set(p.position, g);
    }
    return map;
  }

  // 状态文字解析：本地"请红方下棋/🎉 红方胜利"；联机"你是红方，等绿方下棋/等你下棋"
  function parseStatus() {
    const text = document.body ? (document.body.innerText || '') : '';
    let m = text.match(/(红|绿)方胜利/);
    if (m) return { over: true, winner: m[1] === '红' ? RED : GREEN, mySide: null, turn: null };
    m = text.match(/你是(红|绿)方/);
    const mySide = m ? (m[1] === '红' ? RED : GREEN) : null;
    m = text.match(/[等请](红|绿)方下棋/);
    if (m) return { over: false, turn: m[1] === '红' ? RED : GREEN, mySide };
    if (/等你下棋/.test(text) && mySide !== null) return { over: false, turn: mySide, mySide };
    return { over: false, turn: null, mySide };
  }

  function posFromPieces(pieces) {
    const pos = new Array(16).fill(E.DEAD);
    for (const k in pieces) pos[k] = pieces[k].pos;
    return Int8Array.from(pos);
  }

  function readState() {
    const svg = getBoardSvg();
    if (!svg) return null;
    const { pieces, isRedView } = readPieces(svg);
    const hints = readHints(svg);
    return { svg, pieces, isRedView, hints, pos: posFromPieces(pieces) };
  }

  /* ---------------- 走子执行（模拟点击，公共模块） ---------------- */
  const clickEl = HQ.clickEl, sleep = HQ.sleep;

  function hintsMatchPiece(hints, board, pieceId, piecePos) {
    if (!hints || hints.size === 0) return false;
    const legal = E.genMoves(board, pieceId, piecePos);
    if (legal.length === 0 || hints.size !== legal.length) return false;
    for (const p of hints.keys()) if (!legal.includes(p)) return false;
    return true;
  }

  async function playMove(st, pieceId, to) {
    const piece = st.pieces[pieceId];
    if (!piece || !piece.el) return false;
    // 1) 若目标提示格已显示（棋子已被选中）→ 直接点
    let board = E.boardFrom(st.pos);
    let selected = hintsMatchPiece(st.hints, board, pieceId, piece.pos);
    // 2) 否则点击棋子选中
    if (!selected) {
      const props = findProps(piece.el, pp => pp && pp.id === pieceId && typeof pp.pos === 'number', 4);
      if (!props || !props.onClick) return false; // 不可点：非该方回合（联机）
      clickEl(piece.el);
      const deadline = Date.now() + 1500;
      let found = null;
      while (Date.now() < deadline) {
        await sleep(60);
        const s2 = readState();
        if (!s2) return false;
        const b2 = E.boardFrom(s2.pos);
        if (hintsMatchPiece(s2.hints, b2, pieceId, s2.pieces[pieceId] ? s2.pieces[pieceId].pos : undefined)) { found = s2.hints; break; }
      }
      if (!found) return false;
      st.hints = found;
    }
    const targetEl = st.hints.get(to);
    if (!targetEl) return false;
    clickEl(targetEl);
    return true;
  }

  /* ---------------- 高亮层（独立 svg 覆盖在棋盘上，公共模块） ---------------- */
  let overlay = null, overlayFor = null;
  function ensureOverlay(svg) {
    if (overlay && overlayFor === svg && document.contains(overlay)) return overlay;
    if (overlay) overlay.remove();
    overlay = HQ.createOverlay(svg, svg.getAttribute('viewBox') || '-40 -50 80 100');
    overlayFor = svg;
    return overlay;
  }
  function posToXY(pos, isRedView) {
    const col = pos % 7, row = (pos / 7) | 0;
    return isRedView ? [10 * (col - 3), 10 * (row - 4)] : [10 * (3 - col), 10 * (4 - row)];
  }
  function drawHighlight(svg, isRedView, fromPos, toPos) {
    const ov = ensureOverlay(svg);
    ov.__fit();
    while (ov.firstChild) ov.removeChild(ov.firstChild);
    const [fx, fy] = posToXY(fromPos, isRedView);
    const [tx, ty] = posToXY(toPos, isRedView);
    const mk = (x, y, color) => {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', x - 4.6); r.setAttribute('y', y - 4.6);
      r.setAttribute('width', 9.2); r.setAttribute('height', 9.2);
      r.setAttribute('rx', 1.4);
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', color);
      r.setAttribute('stroke-width', 1.2);
      r.setAttribute('opacity', '0.95');
      return r;
    };
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', fx); line.setAttribute('y1', fy);
    line.setAttribute('x2', tx); line.setAttribute('y2', ty);
    line.setAttribute('stroke', '#38bdf8');
    line.setAttribute('stroke-width', 1.4);
    line.setAttribute('stroke-dasharray', '3 2');
    line.setAttribute('opacity', '0.9');
    ov.appendChild(mk(fx, fy, '#fbbf24'));
    ov.appendChild(mk(tx, ty, '#22c55e'));
    ov.appendChild(line);
  }
  function clearHighlight() { if (overlay) HQ.clearOverlay(overlay); }

  /* ---------------- 主循环 ---------------- */
  let busy = false;
  let history = [];          // 局面 key（重复规避）
  let lastSeenKey = '';       // 上次观察到的局面 key（全量历史用）
  let lastAlive = -1;         // 上次存活棋子数（检测吃子，用于无吃子回合计数）
  let stalePly = 0;           // 自上次吃子以来的半回合数（领先方紧迫感评估用）
  let lastInfo = { text: '等待对局…', key: '' };
  let hintCache = { key: '', result: null };

  function localGameId() {
    // 本地对战以 URL 区分（p/r 参数变化但同一局）; 新局=棋子回到初始
    return location.pathname + (location.search.split('p=')[0] || '');
  }

  async function tick() {
    // 路由门禁：只在斗兽棋页面工作（整合版多游戏共存时避免误读其他游戏页面）
    if (!/\/dsq/.test(location.pathname)) return;
    if (busy) return;
    const st = parseStatus();
    const s = readState();
    if (!s || Object.keys(s.pieces).length === 0) {
      clearHighlight();
      setInfo('未检测到对局');
      renderPanel(st, null);
      return;
    }
    // 新局检测：局面回到初始 → 清历史
    if (history.length && E.posKey(s.pos) === E.posKey(E.INIT_POS)) { history = []; lastSeenKey = ''; }
    // 全量历史：局面每次变化，把上一局面 key 记入（含手动走子与 AI 走子）
    const curKey = E.posKey(s.pos);
    if (lastSeenKey !== curKey) {
      if (lastSeenKey !== '') {
        history.push(lastSeenKey);
        if (history.length > 40) history.shift();
      }
      lastSeenKey = curKey;
      // 无吃子回合计数：存活数变化（有吃子）→ 清零，否则累加
      const aliveNow = Object.keys(s.pieces).length;
      if (lastAlive >= 0 && aliveNow !== lastAlive) stalePly = 0;
      else if (stalePly < 999) stalePly++;
      lastAlive = aliveNow;
    }
    renderPanel(st, s);

    if (st.over) {
      clearHighlight();
      setInfo(st.winner === RED ? '🎉 红方胜利' : '🎉 绿方胜利');
      history = [];
      lastSeenKey = '';
      return;
    }
    if (st.turn === null) { setInfo('等待中（悔棋请求/状态未知）'); return; }

    // ---- 提示模式 ----
    if (settings.hint) {
      const key = E.posKey(s.pos) + '|' + st.turn;
      if (hintCache.key !== key) {
        self.DSQ_FIXED_DEPTH = settings.depth || 0;
        const r = E.search(s.pos, st.turn, settings.time, history.slice(-40), { stalePly });
        hintCache = { key, result: r };
      }
      const r = hintCache.result;
      if (r && r.move) {
        const from = s.pieces[r.move.pieceId] ? s.pieces[r.move.pieceId].pos : r.move.from;
        drawHighlight(s.svg, s.isRedView, from, r.move.to);
        const evalRed = r.score * (st.turn === RED ? 1 : -1);
        const p1 = r.move.from, p2 = r.move.to;
        setInfo(`最佳: ${EM[r.move.pieceId % 8]}${S[r.move.pieceId % 8]} (${((p1 / 7) | 0) + 1},${(p1 % 7) + 1})→(${((p2 / 7) | 0) + 1},${(p2 % 7) + 1}) | 评估 ${evalRed > 0 ? '+' : ''}${(evalRed / 100).toFixed(1)} | ${r.depth > 0 ? '深度' + r.depth + '层' : '开局书'} | 搜索${(r.nodes / 1000).toFixed(1)}k节点`);
      }
    } else {
      clearHighlight();
    }

    // ---- 自动模式 ----
    const onlineMode = st.mySide !== null;
    let wantAuto = false;
    if (settings.auto) {
      if (onlineMode) wantAuto = st.turn === st.mySide;
      else wantAuto = (st.turn === RED && settings.autoRed) || (st.turn === GREEN && settings.autoGreen);
    }
    if (!wantAuto) return;

    // 该方棋子当前是否真的可点（联机中非自己回合时页面不会给 onClick）
    const canClick = Object.values(s.pieces).some(p => p.clickable && (p.id < 8 ? RED : GREEN) === st.turn);
    if (!canClick) return;

    busy = true;
    try {
      await sleep(500 + Math.random() * 1000);   // 拟人延迟
      const s2 = readState();
      const st2 = parseStatus();
      if (!s2 || st2.over || st2.turn !== st.turn) return;
      self.DSQ_FIXED_DEPTH = settings.depth || 0;
      const r = E.search(s2.pos, st.turn, settings.time, history.slice(-40), { stalePly });
      if (!r.move) return;
      const ok = await playMove(s2, r.move.pieceId, r.move.to);
      if (ok) {
        const evalRed = r.score * (st.turn === RED ? 1 : -1);
        const p1 = r.move.from, p2 = r.move.to;
        setInfo(`AI已走: ${EM[r.move.pieceId % 8]}${S[r.move.pieceId % 8]} (${((p1 / 7) | 0) + 1},${(p1 % 7) + 1})→(${((p2 / 7) | 0) + 1},${(p2 % 7) + 1}) | 评估 ${evalRed > 0 ? '+' : ''}${(evalRed / 100).toFixed(1)} | ${r.depth > 0 ? '深度' + r.depth + '层' : '开局书'} | 搜索${(r.nodes / 1000).toFixed(1)}k节点`);
      }
    } catch (err) {
      console.error('[斗兽棋AI]', err);
    } finally {
      busy = false;
    }
  }

  /* ---------------- UI 面板 ---------------- */
  function setInfo(t) { if (infoEl) infoEl.textContent = t; }

  let panelEl = null, infoEl = null;
  function buildPanel(container) {
    if (panelEl) return;
    const style = document.createElement('style');
    style.textContent = `
      #dsqAI{width:212px;background:rgba(15,23,42,.93);
        color:#e2e8f0;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;border-radius:12px;
        box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none;backdrop-filter:blur(4px)}
      #dsqAI .hd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px 5px;cursor:move;font-weight:600}
      #dsqAI .bd{padding:0 10px 10px}
      #dsqAI.min .bd{display:none}
      #dsqAI button{cursor:pointer;border:none;border-radius:7px;padding:4px 0;font-size:12px;flex:1;background:#334155;color:#cbd5e1}
      #dsqAI button.on{background:#3b82f6;color:#fff;font-weight:600}
      #dsqAI .row{display:flex;gap:6px;margin-top:7px;align-items:center}
      #dsqAI label{display:flex;align-items:center;gap:3px;flex:1;color:#cbd5e1}
      #dsqAI input[type=checkbox]{accent-color:#3b82f6}
      #dsqAI input[type=range]{flex:1;accent-color:#3b82f6;height:14px}
      #dsqAI .info{margin-top:7px;padding-top:6px;border-top:1px solid #334155;color:#94a3b8;min-height:30px}
      #dsqAI .x{cursor:pointer;color:#64748b;font-size:14px;padding:0 2px}
    `;
    document.head.appendChild(style);

    panelEl = document.createElement('div');
    panelEl.id = 'dsqAI';
    panelEl.innerHTML = `
      <div class="hd"><span>🐘 斗兽棋 AI</span><span class="x">—</span></div>
      <div class="bd">
        <div class="row">
          <button data-t="hint">💡 提示</button>
          <button data-t="auto">🤖 自动</button>
        </div>
        <div class="row sides">
          <label><input type="checkbox" data-s="autoRed">红方AI</label>
          <label><input type="checkbox" data-s="autoGreen">绿方AI</label>
        </div>
        <div class="row"><span style="flex:none">思考</span><input type="range" data-s="time" min="100" max="5000" step="100"><span class="tv" style="flex:none;width:34px;text-align:right"></span></div>
        <div class="row"><span style="flex:none">深度</span><input type="range" data-s="depth" min="0" max="12" step="1"><span class="tv2" style="flex:none;width:44px;text-align:right"></span></div>
        <div class="info">等待对局…</div>
      </div>`;
    (container || document.body).appendChild(panelEl);
    infoEl = panelEl.querySelector('.info');

    // 事件
    panelEl.querySelectorAll('button[data-t]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.t;
        settings[t] = !settings[t];
        if (t === 'auto' && settings.auto && !settings.autoRed && !settings.autoGreen) settings.autoRed = true;
        saveSettings(); renderPanel(parseStatus(), readState());
      });
    });
    panelEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => { settings[cb.dataset.s] = cb.checked; saveSettings(); });
    });
    panelEl.querySelectorAll('input[type=range]').forEach(r => {
      r.addEventListener('input', () => {
        settings[r.dataset.s] = +r.value;
        hintCache = { key: '', result: null };
        if (r.dataset.s === 'time') panelEl.querySelector('.tv').textContent = (settings.time / 1000).toFixed(1) + 's';
        else panelEl.querySelector('.tv2').textContent = settings.depth ? settings.depth + ' 层' : '自动';
        saveSettings();
      });
    });
    panelEl.querySelector('.x').addEventListener('click', () => panelEl.classList.toggle('min'));

    // 拖动由壳（独立版 wrap / 整合版 shell）接管
    renderPanel(parseStatus(), readState());
  }

  function renderPanel(st, s) {
    if (!panelEl) return;
    panelEl.querySelector('button[data-t=hint]').classList.toggle('on', !!settings.hint);
    panelEl.querySelector('button[data-t=auto]').classList.toggle('on', !!settings.auto);
    const onlineMode = st && st.mySide !== null;
    panelEl.querySelectorAll('.sides input').forEach(cb => {
      cb.checked = !!settings[cb.dataset.s];
      cb.disabled = onlineMode;              // 联机只能代走自己的阵营
      cb.parentElement.style.opacity = onlineMode ? .45 : 1;
      cb.parentElement.title = onlineMode ? '联机对战中自动代走你自己的阵营' : '';
    });
    panelEl.querySelectorAll('input[type=range]').forEach(r => {
      if (+r.value !== settings[r.dataset.s]) r.value = settings[r.dataset.s];
    });
    panelEl.querySelector('.tv').textContent = (settings.time / 1000).toFixed(1) + 's';
    panelEl.querySelector('.tv2').textContent = settings.depth ? settings.depth + ' 层' : '自动';
    if (s && Object.keys(s.pieces).length && !lastInfo.noClear) {
      // info 由 setInfo 更新，这里只在无对局时写默认
    }
  }

  /* ---------------- 注册（壳负责挂载与调度） ---------------- */
  HQ.registerGame({
    id: 'dsq', name: '斗兽棋', icon: '🐘', interval: 400, dragIgnore: 'x',
    route: /\/dsq/,
    canShow: () => !!readState(),          // 开始游戏（检测到棋盘）后才显示面板
    mount(container) {
      self.DSQ_BOOK = 1;                   // 浏览器默认启用迷你开局书（红方首步 狮62->55）
      buildPanel(container);
      return panelEl.querySelector('.hd');
    },
    tick: () => tick(),
  });
  console.log('[斗兽棋AI] 已注册 ✓ 提示模式默认开启');

  /* ---------------- 调试接口 ---------------- */
  window.__dsqAI = {
    readState, parseStatus, search: (pos, side, ms, avoid) => E.search(pos, side, ms, avoid),
    setAuto: (red, green) => { settings.auto = true; settings.autoRed = !!red; settings.autoGreen = !!green; settings.hint = false; saveSettings(); },
    setHint: on => { settings.hint = !!on; saveSettings(); },
    settings, history: () => history,
  };
})();


