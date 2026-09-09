/* ============================================================
 * 五子棋助手 · 页面桥接 + UI（引擎 wzq.core 由 build 注入为 WZQEngine）
 *
 * 页面结构（逆向自 game.hullqin.cn/wzq）：
 *  - 棋盘 svg#svg，viewBox="-80,-80,160,160"，15 路，交点 (x,y)∈{-70..70} 步长 10
 *  - 落子：每个空交点一个 <use xlinkHref="#hover" x y onClick>，单击直接落子
 *  - 本地棋谱：URL 参数 p，每 2 字符一手「列行」（如 "77" = 天元）
 *  - 规则：顶部组件 fiber props.rule（0无禁手 1有禁手 2一手交换 3RIF 4山口 5索索夫8 6塔拉山口10 7Swap2长连不胜）
 *  - 交换/打点等特殊阶段会出现文字提示与按钮，AI 不代做，面板提示用户手动处理
 * ============================================================ */
(function () {
  'use strict';
  const E = (typeof WZQEngine !== 'undefined' && WZQEngine) || self.WZQEngine;
  if (!E) { console.error('[五子棋AI] 引擎未加载'); return; }
  if (self.__wzqAIInjected) return;
  self.__wzqAIInjected = true;

  /* ---------------- 设置 ---------------- */
  const DEFAULTS = { hint: true, auto: false, autoBlack: false, autoWhite: false, level: 5 };
  const clampLevel = lv => Math.min(10, Math.max(1, lv | 0 || 5));   // lv 非法(0/NaN/undefined)时回退 5
  let settings = HQ.loadSettings('wzqAI', DEFAULTS);
  settings.level = clampLevel(settings.level);
  const saveSettings = () => HQ.saveSettings('wzqAI', settings);

  const RULE_NAMES = ['无禁手', '有禁手', '一手交换', 'RIF规则', '山口规则', '索索夫8规则', '塔拉山口10规则', 'Swap2长连不胜'];
  // 难度 = 思考深度（层数 1~10）。思考时间上限 10s，给足预算让搜索能尽量达成目标深度。
  // 低难度在根节点分差 ≤ cp 的候选里随机（放水让 AI 变弱）。
  const LEVELS = {
    1: { d: 1, t: 500, cp: 600 },
    2: { d: 2, t: 1000, cp: 400 },
    3: { d: 3, t: 2000, cp: 200 },
    4: { d: 4, t: 3000, cp: 90 },
    5: { d: 5, t: 4000, cp: 40 },
    6: { d: 6, t: 5000, cp: 15 },
    7: { d: 7, t: 6000, cp: 0 },
    8: { d: 8, t: 7000, cp: 0 },
    9: { d: 9, t: 8000, cp: 0 },
    10: { d: 10, t: 10000, cp: 0 },
  };

  /* ---------------- 页面读取 ---------------- */
  function getBoardSvg() {
    const s = document.getElementById('svg');
    return (s && s.getAttribute('viewBox') === '-80,-80,160,160') ? s : null;
  }

  // 顶层组件 C 的 props: {p, searchParams, setSearchParams, state, rule}
  function readTopProps(svg) {
    const el = svg.querySelector('rect') || svg.querySelector('use') || svg;
    return HQ.findProps(el, pp => pp && pp.rule !== undefined && pp.searchParams !== undefined, 10);
  }

  // 从 URL search 读 p（本地模式主来源）
  function readP() {
    try { return new URLSearchParams(location.search).get('p') || ''; } catch (e) { return ''; }
  }

  // 交点元素表：pos -> <use>（可点击的空点）
  // 联机棋盘渲染 pos=15*E+e 时 x=10*E（行）、y=10*e（列），与本地转置 → 用 xyToPosT
  function readHovers(svg, transposed) {
    const xToPos = transposed ? E.xyToPosT : E.xyToPos;
    const map = new Map();
    for (const u of svg.querySelectorAll('use')) {
      const p = HQ.findProps(u, pp => pp && typeof pp.x === 'number' && typeof pp.y === 'number' && pp.onClick !== undefined, 3);
      if (p && (p.xlinkHref || '').indexOf('#hover') === 0) map.set(xToPos(p.x, p.y), u);
    }
    return map;
  }

  // 状态文字
  function parseStatus() {
    const text = document.body ? (document.body.innerText || '') : '';
    const m = text.match(/(黑|白)方胜/);
    if (m) return { over: true, winner: m[1] === '黑' ? E.BLACK : E.WHITE };
    if (/平局|和棋/.test(text)) return { over: true, winner: 0 };
    const s2 = text.match(/请(黑|白)方下棋/);
    if (s2) return { over: false, turn: s2[1] === '黑' ? E.BLACK : E.WHITE };
    // 特殊阶段（交换/打点）：出现这些文案时不代走
    if (/决定是否交换|选择是否交换|打点|swap/i.test(text)) return { over: false, turn: null, special: true };
    return { over: false, turn: null };
  }

  function readState() {
    const svg = getBoardSvg();
    if (!svg) return null;
    // 1) 联机模式：fiber 上的 view（WZQGameData 展开对象，组件 props {isPlayer, view, room, send}）
    //    phase（模块1323）：0开局 1等交换 2等声明 3等提案 4等选择 5对局中 6黑胜 7白胜 8平 9塔拉分支 10等Swap2
    const net = HQ.findProps(svg.querySelector('rect') || svg.querySelector('use') || svg,
      pp => pp && pp.view && Array.isArray(pp.view.pieceList) && pp.room && pp.room.position !== undefined, 12);
    if (net) {
      const v = net.view;
      const myPos = net.room.position - 1;          // 0 基座位
      const board = new Int8Array(E.SIZE);
      let n = 0;
      v.pieceList.forEach((q, idx) => {
        if (Number.isInteger(q) && q >= 0 && q < E.SIZE) {
          board[q] = idx % 2 === 0 ? E.BLACK : E.WHITE;
          n++;
        }
      });
      const phase = v.phase;
      const over = phase === 6 || phase === 7 || phase === 8;
      return {
        svg, board, movesCount: n, fromDom: false, online: true,
        rule: v.rule || 0, phase, over,
        special: !over && phase !== 5,
        myBlack: v.blackId === myPos,
        myTurn: v.waitFor === myPos && (v.reqBackBy === undefined || v.reqBackBy === -1),
        turnByCount: n % 2 === 0 ? E.BLACK : E.WHITE,
        p: '',
      };
    }
    // 2) 本地模式：URL 棋谱 p
    const top = readTopProps(svg);
    const p = readP();
    const { board, moves } = E.fromP(p);
    // DOM 校验：棋盘上实际棋子数应与棋谱一致（异常时从 DOM 重建）
    const domStones = [...svg.querySelectorAll('use')].filter(u => {
      const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      return h === '#piece';
    }).length;
    if (domStones !== moves.length) {
      const b = new Int8Array(E.SIZE);
      let n = 0;
      for (const u of svg.querySelectorAll('use')) {
        const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
        if (h !== '#piece') continue;
        const x = u.getAttribute('x'), y = u.getAttribute('y');
        if (x === null || y === null) continue;
        const fill = u.getAttribute('fill') || '';
        b[E.xyToPos(+x, +y)] = fill.includes('black') ? E.BLACK : E.WHITE;
        n++;
      }
      const turn = n % 2 === 0 ? E.BLACK : E.WHITE;
      return { svg, board: b, movesCount: n, turnByCount: turn, rule: top ? top.rule : 0, fromDom: true, online: false, p };
    }
    const turn = moves.length % 2 === 0 ? E.BLACK : E.WHITE;
    return { svg, board, moves, movesCount: moves.length, turnByCount: turn, rule: top ? top.rule : 0, fromDom: false, online: false, p };
  }

  /* ---------------- 走子执行（模拟点击交点） ---------------- */
  const clickEl = HQ.clickEl, sleep = HQ.sleep;

  async function playMove(st, pos) {
    const hovers = readHovers(st.svg, st.online);
    let el = hovers.get(pos);
    if (!el) {
      // 空点尚未渲染 hover？等待一拍重读
      await sleep(120);
      const s2 = readState();
      if (!s2 || !s2.svg) return false;
      el = readHovers(s2.svg, s2.online).get(pos);
      if (!el) return false;
    }
    clickEl(el);
    return true;
  }

  /* ---------------- 高亮层 ---------------- */
  let overlay = null, overlayFor = null;
  function ensureOverlay(svg) {
    if (overlay && overlayFor === svg && document.contains(overlay)) { overlay.__fit(); return overlay; }
    if (overlay) overlay.remove();
    overlay = HQ.createOverlay(svg, '-80,-80,160,160');
    overlayFor = svg;
    return overlay;
  }
  function drawHighlight(svg, pos, secondary, transposed) {
    const ov = ensureOverlay(svg);
    HQ.clearOverlay(ov);
    const toXY = transposed ? E.posToXYT : E.posToXY;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const { x, y } = toXY(pos);
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 5);
    c.setAttribute('fill', 'rgba(56,189,248,.18)');
    c.setAttribute('stroke', '#38bdf8');
    c.setAttribute('stroke-width', 1.2);
    c.setAttribute('opacity', '.95');
    ov.appendChild(c);
    if (secondary !== undefined && secondary !== pos && secondary >= 0) {
      const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const q = toXY(secondary);
      c2.setAttribute('cx', q.x); c2.setAttribute('cy', q.y); c2.setAttribute('r', 4);
      c2.setAttribute('fill', 'none');
      c2.setAttribute('stroke', '#a855f7');
      c2.setAttribute('stroke-width', 0.9);
      c2.setAttribute('opacity', '.8');
      c2.setAttribute('stroke-dasharray', '2 2');
      ov.appendChild(c2);
    }
  }
  function clearHighlight() { if (overlay) HQ.clearOverlay(overlay); }

  /* ---------------- 主循环 ---------------- */
  let busy = false;
  let hintCache = { key: '', result: null };
  let lastP = '';

  const sideName = c => c === E.BLACK ? '黑方' : '白方';

  async function tick() {
    // 路由门禁：只在五子棋页面工作
    const onRoute = /\/wzq/.test(location.pathname);
    if (panelEl) panelEl.style.display = onRoute ? '' : 'none';
    if (!onRoute) { clearHighlight(); return; }
    if (busy) return;
    const st = readState();
    if (!st) { clearHighlight(); setInfo('未检测到五子棋棋盘'); return; }
    const stat = st.online ? { over: st.over, special: st.special, turn: null } : parseStatus();
    renderPanel(st, stat);

    if (st.online) {
      // 联机：phase 驱动（6黑胜 7白胜 8平；5对局中；其余开局特殊阶段）
      if (st.over) {
        clearHighlight();
        setInfo(st.phase === 6 ? '🎉 黑方胜利' : st.phase === 7 ? '🎉 白方胜利' : '🤝 平局');
        return;
      }
      if (st.special) { clearHighlight(); setInfo(`开局特殊阶段（phase ${st.phase}）— 请手动完成后 AI 继续`); return; }
    } else {
      if (stat.over) {
        clearHighlight();
        setInfo(stat.winner ? `🎉 ${sideName(stat.winner)}胜利` : '🤝 平局');
        return;
      }
      if (stat.special) { clearHighlight(); setInfo('开局特殊阶段（交换/打点）— 请手动完成后 AI 继续'); return; }
    }

    // 规则显示
    const ruleName = RULE_NAMES[st.rule] || ('规则' + st.rule);

    // 行棋方：本地文字解析优先，手数兜底；联机直接用手数（偶黑奇白）
    const turn = !st.online && stat.turn !== null ? stat.turn : st.turnByCount;

    // ---- 提示模式 ----
    if (settings.hint) {
      const key = (st.online ? 'net' : st.p) + '|' + st.movesCount + '|' + turn + '|' + st.rule + '|' + settings.level;
      if (hintCache.key !== key) {
        const prof = LEVELS[clampLevel(settings.level)];
        const r0 = E.search(st.board, turn, { rule: st.rule, timeMs: prof.t, maxDepth: prof.d });
        let pick = r0;
        if (prof.cp > 0 && r0.root && r0.root.length > 1) {
          const cand = r0.root.filter(x => x.sc >= r0.score - prof.cp);
          if (cand.length) {
            const c = cand[Math.floor(Math.random() * cand.length)];
            pick = { ...r0, move: c.pos, score: c.sc };
          }
        }
        hintCache = { key, result: pick };
      }
      const r = hintCache.result;
      if (r && r.move >= 0) {
        const second = r.root && r.root[1] ? r.root[1].pos : undefined;
        drawHighlight(st.svg, r.move, second, st.online);
        const winNow = r.score > E.WIN - 1000, loseNow = r.score < -(E.WIN - 1000);
        const myTag = st.online ? `（我是${st.myBlack ? '黑' : '白'}方${st.myTurn ? '·轮到你' : ''}）` : '';
        setInfo(`【${ruleName}】${myTag}${sideName(turn)}最佳: ${E.posName(r.move)} | ${winNow ? '必胜!' : loseNow ? '⚠必败' : '评估 ' + (r.score / 1000).toFixed(1)} | 深度${r.depth}`);
      }
    } else {
      clearHighlight();
    }

    // ---- 自动模式 ----
    let wantAuto = false;
    if (settings.auto) {
      if (st.online) {
        // 联机：只能也只会代走自己（waitFor 命中我的座位 + 颜色吻合）
        const myColor = st.myBlack ? E.BLACK : E.WHITE;
        wantAuto = st.myTurn && turn === myColor;
      } else {
        wantAuto = (turn === E.BLACK && settings.autoBlack) || (turn === E.WHITE && settings.autoWhite);
      }
    }
    if (!wantAuto) return;

    busy = true;
    try {
      await sleep(400 + Math.random() * 800);   // 拟人延迟
      const s2 = readState();
      if (!s2) return;
      if (s2.online) {
        if (s2.over || s2.special) return;
        const myColor2 = s2.myBlack ? E.BLACK : E.WHITE;
        if (!s2.myTurn || s2.turnByCount !== myColor2) return;
      } else {
        const st2 = parseStatus();
        if (st2.over || st2.special) return;
        const turn2 = st2.turn !== null ? st2.turn : s2.turnByCount;
        if (turn2 === null || turn2 !== s2.turnByCount) return;
      }
      const turn2 = s2.turnByCount;
      const key2 = (s2.online ? 'net' : s2.p) + '|' + s2.movesCount + '|' + turn2 + '|' + s2.rule + '|' + settings.level;
      let r;
      if (hintCache.key === key2 && hintCache.result) r = hintCache.result;
      else {
        const prof = LEVELS[clampLevel(settings.level)];
        r = E.search(s2.board, turn2, { rule: s2.rule, timeMs: prof.t, maxDepth: prof.d });
        hintCache = { key: key2, result: r };
      }
      if (!r || r.move < 0) {
        // 无棋可走（如被禁手杀）：走一步合法点让对局走到终局
        const d = E.desperateMove(s2.board, turn2, s2.rule);
        if (d >= 0) {
          await playMove(s2, d);
          setInfo('⚠ 已无胜路（无子可走/禁手杀），尽力走一步');
        } else setInfo('⚠ 完全无合法落点');
        return;
      }
      const ok = await playMove(s2, r.move);
      if (ok) setInfo(`AI已落: ${E.posName(r.move)} | ${r.score > E.WIN - 1000 ? '必胜!' : '深度' + r.depth}`);
    } catch (err) {
      console.error('[五子棋AI]', err);
    } finally {
      busy = false;
    }
  }

  /* ---------------- UI 面板 ---------------- */
  let panelEl = null, infoEl = null;
  function setInfo(t) { if (infoEl) infoEl.textContent = t; }

  function buildPanel(container) {
    if (panelEl) return;
    const style = document.createElement('style');
    style.textContent = `
      #wzqAI{width:216px;background:rgba(15,23,42,.93);
        color:#e2e8f0;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;border-radius:12px;
        box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none;backdrop-filter:blur(4px)}
      #wzqAI .hd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px 5px;cursor:move;font-weight:600}
      #wzqAI .bd{padding:0 10px 10px}
      #wzqAI.min .bd{display:none}
      #wzqAI button{cursor:pointer;border:none;border-radius:7px;padding:4px 0;font-size:12px;flex:1;background:#334155;color:#cbd5e1}
      #wzqAI button.on{background:#3b82f6;color:#fff;font-weight:600}
      #wzqAI .row{display:flex;gap:6px;margin-top:7px;align-items:center}
      #wzqAI label{display:flex;align-items:center;gap:3px;flex:1;color:#cbd5e1}
      #wzqAI input[type=checkbox]{accent-color:#3b82f6}
      #wzqAI input[type=range]{flex:1;accent-color:#3b82f6;height:14px}
      #wzqAI .info{margin-top:7px;padding-top:6px;border-top:1px solid #334155;color:#94a3b8;min-height:30px;word-break:break-all}
      #wzqAI .x{cursor:pointer;color:#64748b;font-size:14px;padding:0 2px}
      #wzqAI .lvtxt{font-size:11px;color:#fbbf24;width:44px;text-align:right}
    `;
    document.head.appendChild(style);

    panelEl = document.createElement('div');
    panelEl.id = 'wzqAI';
    panelEl.innerHTML = `
      <div class="hd"><span>⚫ 五子棋 AI</span><span class="x">—</span></div>
      <div class="bd">
        <div class="row">
          <button data-t="hint">💡 提示</button>
          <button data-t="auto">🤖 自动</button>
        </div>
        <div class="row sides">
          <label><input type="checkbox" data-s="autoBlack">黑方AI</label>
          <label><input type="checkbox" data-s="autoWhite">白方AI</label>
        </div>
        <div class="row"><span style="flex:none">深度</span><input type="range" data-s="level" min="1" max="10" step="1"><span class="lvtxt" style="flex:none;width:44px;text-align:right"></span></div>
        <div class="info">等待对局…</div>
      </div>`;
    (container || document.body).appendChild(panelEl);
    infoEl = panelEl.querySelector('.info');

    panelEl.querySelectorAll('button[data-t]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.t;
        settings[t] = !settings[t];
        if (t === 'auto' && settings.auto && !settings.autoBlack && !settings.autoWhite) settings.autoBlack = true;
        saveSettings(); renderPanel(readState(), parseStatus());
      });
    });
    panelEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', () => { settings[cb.dataset.s] = cb.checked; saveSettings(); });
    });
    panelEl.querySelectorAll('input[type=range]').forEach(r => {
      r.addEventListener('input', () => {
        const v = +r.value;
        settings[r.dataset.s] = r.dataset.s === 'level' ? clampLevel(v) : v;
        hintCache = { key: '', result: null };
        saveSettings(); renderPanel(readState(), parseStatus());
      });
    });
    panelEl.querySelector('.x').addEventListener('click', () => panelEl.classList.toggle('min'));
        renderPanel(readState(), parseStatus());
  }

  function renderPanel(st, stat) {
    if (!panelEl) return;
    panelEl.querySelector('button[data-t=hint]').classList.toggle('on', !!settings.hint);
    panelEl.querySelector('button[data-t=auto]').classList.toggle('on', !!settings.auto);
    const onlineMode = !!(st && st.online);
    panelEl.querySelectorAll('.sides input').forEach(cb => {
      cb.checked = !!settings[cb.dataset.s];
      cb.disabled = onlineMode;                     // 联机只能代走自己的颜色
      cb.parentElement.style.opacity = onlineMode ? .45 : 1;
      cb.parentElement.title = onlineMode ? '联机对战中自动代走你自己的颜色' : '';
    });
    panelEl.querySelectorAll('input[type=range]').forEach(r => {
      if (+r.value !== settings[r.dataset.s]) r.value = settings[r.dataset.s];
    });
    const lt = panelEl.querySelector('.lvtxt');
    if (lt) lt.textContent = clampLevel(settings.level) + ' 层';
  }

  /* ---------------- 注册（壳负责挂载与调度） ---------------- */
  HQ.registerGame({
    id: 'wzq', name: '五子棋', icon: '⚫', interval: 400, dragIgnore: 'x',
    route: /\/wzq/,
    mount(container) {
      buildPanel(container);
      return panelEl.querySelector('.hd');
    },
    tick: () => tick(),
  });
  console.log('[五子棋AI] 已注册 ✓ 提示模式默认开启');

  /* ---------------- 调试接口 ---------------- */
  function diag() {
    const st = readState();
    const svg = getBoardSvg();
    return {
      url: location.href,
      hasSvg: !!svg,
      state: st ? {
        online: st.online, movesCount: st.movesCount, rule: st.rule, phase: st.phase,
        myBlack: st.myBlack, myTurn: st.myTurn, turnByCount: st.turnByCount,
      } : null,
      statusText: parseStatus(),
    };
  }
  self.__wzqAI = {
    readState, parseStatus, diag,
    search: (board, color, opts) => E.search(board, color, opts),
    setAuto: (black, white) => { settings.auto = true; settings.autoBlack = !!black; settings.autoWhite = !!white; settings.hint = false; saveSettings(); },
    settings,
  };
})();
