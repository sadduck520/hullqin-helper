/* ============================================================
 * 跳棋助手 · 页面桥接 + UI（引擎 tq.core 由 build 注入为 TQEngine）
 *
 * 页面结构（逆向自 game.hullqin.cn/tq 前端 tq chunk 模块 4 + UI 层）：
 *  - 棋盘 svg viewBox="500,-127,1400,1620"；格位像素 fE(Us(pos)) = [100*(q+r/2), 100*r*0.866025]
 *  - 棋子：circle（fill = 玩家色 DM[playerIdx]），轮到自己时可点，点击选中
 *  - routeMode 0：选中后渲染候选终点圈（fillOpacity=0、stroke 描边、onClick→onMove(route)），点终点即走
 *  - routeMode 1：逐跳点击累积路线，再点「确认移动」按钮
 *  - 状态：props.view（已展开：waitFor/playerPieces/pos/pieceCount/rule/routeMode/winnerId/finish/lastOp）
 *  - 我的座位：room.position（1 基）→ 玩家下标 = position - 1（waitFor/winnerId 均 0 基）
 *  - 目标营 = 对面营（营 c + 3 mod 6）；全员入营者按先后记入 winnerId
 * ============================================================ */
(function () {
  'use strict';
  const E = (typeof TQEngine !== 'undefined' && TQEngine) || self.TQEngine;
  if (!E) { console.error('[跳棋AI] 引擎未加载'); return; }
  if (self.__tqAIInjected) return;
  self.__tqAIInjected = true;

  /* ---------------- 设置 ---------------- */
  const DEFAULTS = { hint: true, auto: false, depth: 2, localSide: -1 };   // localSide: -1=全部 0..5=指定玩家（本地模式）
  let settings = HQ.loadSettings('tqAI', DEFAULTS);
  const saveSettings = () => HQ.saveSettings('tqAI', settings);

  /* ---------------- 页面读取 ---------------- */
  function readTQ() {
    // view：任意持有已展开牌局的组件；room：座位信息（观战时可能没有 position）
    let view = null, room = null, viewEl = null;
    const root = document.getElementById('root') || document.body;
    for (const el of root.querySelectorAll('div,section,svg')) {
      if (!view) {
        const p = HQ.findProps(el, pp => pp && pp.view && Array.isArray(pp.view.playerPieces) && pp.view.waitFor !== undefined, 8);
        if (p) { view = p.view; viewEl = el; }
      }
      if (!room) {
        const p2 = HQ.findProps(el, pp => pp && pp.room && Array.isArray(pp.room.playerList), 8);
        if (p2) room = p2.room;
      }
      if (view && room) break;
    }
    if (!view) return null;
    const myIdx = room && typeof room.position === 'number' && room.position > 0 ? room.position - 1 : null;
    return { view, myIdx, playerCount: room && Array.isArray(room.playerList) ? room.playerList.length : view.playerPieces.length };
  }

  /* ---------------- 走子执行（模拟点击） ---------------- */
  const clickEl = HQ.clickEl, sleep = HQ.sleep;

  // 格位像素（与站点 fE(Us(idx)) 一致）
  function pxOf(idx) {
    const q = E.U[idx], r = E.L[idx];
    return [100 * (q + r / 2), 100 * r * 0.866025];
  }
  // 在 svg 里找匹配格位坐标的 circle
  // kind: 'piece'=棋子（r45+onClick+非透明） | 'dest'=候选终点（r45+fillOpacity 0） | 'any'=任意 r45
  // （棋盘另有 121 个 r=35 的底格圆点，必须排除）
  function findCircle(svg, idx, kind) {
    const [x, y] = pxOf(idx);
    kind = kind || 'any';
    const getFiber = el => { for (const k in el) if (k.indexOf('__reactFiber') === 0) return el[k]; return null; };
    for (const c of svg.querySelectorAll('circle')) {
      if (c.getAttribute('r') !== '45') continue;
      const cx = parseFloat(c.getAttribute('cx')), cy = parseFloat(c.getAttribute('cy'));
      if (!Number.isFinite(cx) || Math.abs(cx - x) >= 0.01 || Math.abs(cy - y) >= 0.01) continue;
      const fo = c.getAttribute('fill-opacity');          // React fillOpacity → DOM fill-opacity
      if (kind === 'piece' && (fo === '0' || !getFiber(c) || !(getFiber(c).memoizedProps || {}).onClick)) continue;
      if (kind === 'dest' && fo !== '0') continue;
      return c;
    }
    return null;
  }

  async function playRoute(svg, view, route) {
    const interactive = view.routeMode === 1;
    // 1) 点选起点棋子
    let pieceEl = findCircle(svg, route[0], 'piece');
    if (!pieceEl) return false;
    clickEl(pieceEl);
    await sleep(260);
    // 2) routeMode 1：逐跳点击 + 确认
    if (interactive) {
      for (let i = 1; i < route.length; i++) {
        const hopEl = findCircle(svg, route[i], 'dest');
        if (!hopEl) return false;
        clickEl(hopEl);
        await sleep(220);
      }
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('确认移动'));
      if (btn) { clickEl(btn); return true; }
      return false;
    }
    // 3) routeMode 0：点终点（多条同终点路线均可，都是合法着）
    let destEl = findCircle(svg, route[route.length - 1], 'dest');
    if (!destEl) {
      await sleep(200);
      destEl = findCircle(svg, route[route.length - 1], 'dest');
      if (!destEl) return false;
    }
    clickEl(destEl);
    return true;
  }

  /* ---------------- 提示高亮（选中棋子让 UI 渲染终点，再标注建议终点） ---------------- */
  let markEl = null;
  function markPoint(svg, idx, color) {
    clearMark();
    const c = findCircle(svg, idx, 'dest') || findCircle(svg, idx, 'any');
    if (!c) return;
    const r = c.getBoundingClientRect();
    markEl = document.createElement('div');
    markEl.style.cssText = `position:fixed;left:${r.left + r.width / 2 - 9}px;top:${r.top + r.height / 2 - 9}px;width:18px;height:18px;border:3px solid ${color};border-radius:50%;pointer-events:none;z-index:9998;box-shadow:0 0 10px ${color};`;
    document.body.appendChild(markEl);
  }
  function clearMark() { if (markEl) { markEl.remove(); markEl = null; } }

  /* ---------------- 主循环 ---------------- */
  let busy = false;
  let hintCache = { key: '', result: null };
  let hist = [];               // 近期局面 key（防 Plateau 横跳）
  let lastKey = '';

  const stateKey = view => view.playerPieces.map(a => a.join('+')).join('|');

  async function tick() {
    const onRoute = /\/tq/.test(location.pathname);
    if (panelEl) panelEl.style.display = onRoute ? '' : 'none';
    if (!onRoute) return;
    if (busy) return;

    const game = readTQ();
    if (!game) { setInfo('未检测到跳棋对局（进入房间或本地对战开局后工作）'); return; }
    const { view, myIdx } = game;
    const n = view.playerPieces.length;
    const online = myIdx != null;

    // 终局 / 完胜排名
    if (view.finish || (view.winnerId && view.winnerId.length >= n - 1 && n > 1)) {
      const order = (view.winnerId || []).map(i => '玩家' + (i + 1)).join(' > ');
      setInfo(`🏁 对局结束 名次: ${order}${view.winnerId && view.winnerId.length < n ? ' > 其余' : ''}`);
      return;
    }

    // 行动资格：联机=我自己回合；本地=托管且当前轮到被代走的一方
    const imDone = online && (view.winnerId || []).includes(myIdx);
    const myTurn = online
      ? view.waitFor === myIdx && !imDone
      : settings.auto && (settings.localSide === -1 || settings.localSide === view.waitFor);
    if (!myTurn) {
      if (!online) setInfo(`本地对战 第${view.round}轮 — 请玩家${view.waitFor + 1}下棋`);
      else if (imDone) setInfo(`🎉 你已完成（第${(view.winnerId || []).indexOf(myIdx) + 1}名）`);
      else setInfo(`等待玩家${view.waitFor + 1}出棋…（第${view.round}轮）`);
      return;
    }
    const actor = online ? myIdx : view.waitFor;   // 本地模式代走当前轮到的一方

    // 决策
    const curKey = stateKey(view);
    if (lastKey && lastKey !== curKey) { hist.push(lastKey); if (hist.length > 40) hist.shift(); }
    lastKey = curKey;
    const key = curKey + '|' + settings.depth;
    let route;
    if (hintCache.key === key) route = hintCache.result;
    else {
      const r = E.search(view, actor, { depth: settings.depth, noise: 4, avoidKeys: hist.slice(-40) });
      route = r.route;
      hintCache = { key, result: route };
    }
    if (!route) { setInfo('无棋可走（等待跳过）'); return; }

    // 提示：选中起点让 UI 渲染终点，标注建议终点（托管时跳过，避免与自动走子的点击互相干扰）
    if (settings.hint && !settings.auto) {
      const svg = document.querySelector('svg[viewBox="500,-127,1400,1620"]');
      if (svg && !busy) {
        const pieceEl = findCircle(svg, route[0], 'piece');
        if (pieceEl && pieceEl.getAttribute('stroke') !== 'black') {
          clickEl(pieceEl);                       // 选中
          await sleep(120);
        }
        markPoint(svg, route[route.length - 1], '#38bdf8');
      }
    }

    if (!settings.auto) {
      const names = route.map(p => '(' + (E.U[p]) + ',' + (E.L[p]) + ')').join('→');
      setInfo(`建议: ${route.length === 2 ? '单步' : '链跳×' + (route.length - 1)} ${names} | 玩家${actor + 1}共${view.playerPieces[actor].length}子`);
      return;
    }

    busy = true;
    try {
      await sleep(400 + Math.random() * 600);
      const game2 = readTQ();
      if (!game2 || game2.view.waitFor !== actor || game2.view.finish) return;
      const svg = document.querySelector('svg[viewBox="500,-127,1400,1620"]');
      if (!svg) return;
      const ok = await playRoute(svg, game2.view, route);
      setInfo(ok ? `AI已走（玩家${actor + 1}） ${route.length === 2 ? '单步' : '链跳×' + (route.length - 1)}` : '⚠ 点击走子失败');
    } catch (err) {
      console.error('[跳棋AI]', err);
    } finally { busy = false; }
  }

  /* ---------------- UI ---------------- */
  let panelEl = null, infoEl = null;
  function setInfo(t) { if (infoEl) infoEl.textContent = t; }

  function buildPanel(container) {
    if (panelEl) return;
    const style = document.createElement('style');
    style.textContent = `
      #tqAI{width:212px;background:rgba(15,23,42,.93);
        color:#e2e8f0;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;border-radius:12px;
        box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none;backdrop-filter:blur(4px)}
      #tqAI .hd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px 5px;cursor:move;font-weight:600}
      #tqAI .bd{padding:0 10px 10px}
      #tqAI.min .bd{display:none}
      #tqAI button{cursor:pointer;border:none;border-radius:7px;padding:4px 0;font-size:12px;flex:1;background:#334155;color:#cbd5e1}
      #tqAI button.on{background:#3b82f6;color:#fff;font-weight:600}
      #tqAI .row{display:flex;gap:6px;margin-top:7px;align-items:center}
      #tqAI .info{margin-top:7px;padding-top:6px;border-top:1px solid #334155;color:#94a3b8;min-height:30px;word-break:break-all}
      #tqAI .x{cursor:pointer;color:#64748b;font-size:14px;padding:0 2px}
    `;
    document.head.appendChild(style);
    panelEl = document.createElement('div');
    panelEl.id = 'tqAI';
    panelEl.innerHTML = `
      <div class="hd"><span>🎯 跳棋 AI</span><span class="x">—</span></div>
      <div class="bd">
        <div class="row">
          <button data-t="hint">💡 提示</button>
          <button data-t="auto">🤖 托管</button>
        </div>
        <div class="row localrow" style="display:none"><span style="flex:none">代走</span>
          <select data-s="localSide" style="flex:1;background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:3px"></select>
        </div>
        <div class="row"><span style="flex:none">深度</span><input type="range" data-s="depth" min="2" max="3" step="1" style="flex:1"><span class="dv" style="flex:none;width:24px;text-align:right"></span></div>
        <div class="info">等待对局…</div>
      </div>`;
    (container || document.body).appendChild(panelEl);
    infoEl = panelEl.querySelector('.info');
    panelEl.querySelectorAll('button[data-t]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.t;
        settings[t] = !settings[t];
        saveSettings(); renderPanel();
      });
    });
    panelEl.querySelector('input[type=range]').addEventListener('input', e => {
      settings.depth = +e.target.value;
      saveSettings(); renderPanel();
    });
    panelEl.querySelector('select[data-s=localSide]').addEventListener('change', e => {
      settings.localSide = +e.target.value;
      saveSettings();
    });
    panelEl.querySelector('.x').addEventListener('click', () => panelEl.classList.toggle('min'));
        renderPanel();
  }
  function renderPanel() {
    if (!panelEl) return;
    panelEl.querySelectorAll('button[data-t]').forEach(b => b.classList.toggle('on', !!settings[b.dataset.t]));
    const dv = panelEl.querySelector('.dv');
    if (dv) dv.textContent = settings.depth + '层';
    const r = panelEl.querySelector('input[type=range]');
    if (r && +r.value !== settings.depth) r.value = settings.depth;
    // 本地模式的「代走方」选择（联机模式隐藏，联机固定代走自己）
    const sel = panelEl.querySelector('select[data-s=localSide]');
    const isLocal = new URLSearchParams(location.search).get('p') !== null;
    sel.parentElement.style.display = isLocal ? '' : 'none';
    const g = readTQ();
    const n = g ? g.playerCount : 2;
    const want = ['全部（AI互走）'].concat(Array.from({ length: n }, (_, i) => '玩家' + (i + 1)));
    const cur = sel.value;
    sel.innerHTML = want.map((t, i) => `<option value="${i - 1}">${t}</option>`).join('');
    sel.value = String(settings.localSide === undefined ? -1 : settings.localSide);
    if (![...sel.options].some(o => o.value === sel.value)) sel.value = '-1';
    void cur;
  }

  /* ---------------- 启动 ---------------- */
  /* ---------------- 注册（壳负责挂载与调度） ---------------- */
  HQ.registerGame({
    id: 'tq', name: '跳棋', icon: '🎯', interval: 450, dragIgnore: 'x',
    route: /\/tq/,
    mount(container) {
      buildPanel(container);
      return panelEl.querySelector('.hd');
    },
    tick: () => tick(),
  });
  console.log('[跳棋AI] 已注册 ✓ 提示模式默认开启');

  /* ---------------- 调试接口 ---------------- */
  self.__tqAI = {
    readState: readTQ,
    diag: () => {
      const g = readTQ();
      if (!g) return { found: false };
      const { view, myIdx, playerCount } = g;
      return {
        found: true,
        waitFor: view.waitFor, myIdx, playerCount,
        round: view.round, phase: { rule: view.rule, routeMode: view.routeMode, pieceCount: view.pieceCount },
        finish: view.finish, winnerId: view.winnerId,
        myPieces: myIdx != null ? view.playerPieces[myIdx] : null,
        campLayout: view.pos,
      };
    },
    settings,
  };
})();
