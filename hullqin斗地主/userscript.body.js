/* ============================================================
 * 斗地主助手 · 页面桥接 + UI（引擎 ddz.core 由 build 注入为 DDZEngine）
 *
 * 页面结构（逆向自 game.hullqin.cn/ddz 前端 ddz chunk 模块 6139/5911）：
 *  - 服务器状态为精简对象 {rule, state, landlordId, cardPositionList, playedCardList, v}
 *    挂在房间组件 fiber props 上（本脚本用 HQ.findProps 探测 props.cardPositionList）
 *  - cardPositionList: 第 i 项（0 基）= 牌 i+1 的归属码；低 3 位 = 玩家号，位 3 = 底牌
 *  - playedCardList: 出牌流水，出牌 push [0, ...牌id]，过牌 push [0]
 *  - state: 0=叫地主，1..n=轮到玩家 n，9..12=玩家 N 胜（>8 即终局）
 *  - 牌 DOM：每张牌一个 <div id=牌id>（模块 6139 牌组件），点击选牌
 *  - 操作按钮按文字定位：「出牌」「过」「叫地主」等
 *
 * ⚠ 联机对局需登录+真实对手，本桥接的状态读取与出牌点击在真实牌局中
 *   可能需要微调；调试接口 window.__ddzAI.dump() 可导出原始 props 便于校准。
 * ============================================================ */
(function () {
  'use strict';
  const E = (typeof DDZEngine !== 'undefined' && DDZEngine) || self.DDZEngine;
  if (!E) { console.error('[斗地主AI] 引擎未加载'); return; }
  if (self.__ddzAIInjected) return;
  self.__ddzAIInjected = true;

  /* ---------------- 设置 ---------------- */
  const DEFAULTS = { counter: true, hint: true, auto: false };
  let settings = HQ.loadSettings('ddzAI', DEFAULTS);
  const saveSettings = () => HQ.saveSettings('ddzAI', settings);

  /** 最后一手牌是谁出的（座位号；无则 0） */
  function lastCardsFrom(st, playerCount) {
    if (!st.playedCardList.length) return 0;
    // 重建每手出牌记录：从 playedCardList 分段（0 分隔，但首元素也是 0）
    // 简化：跟踪 cardPositionList 无法还原历史，改由"倒数第非0段前驱 0 的个数"不可靠。
    // 用另一个办法：state=轮到谁 → 出牌者 = state-1（mod）……不可靠。
    // 保守方案：由外部（fiber 的 lastFrom / UI 文本）提供；这里默认 0=未知
    return st._lastFrom || 0;
  }

  /* ---------------- 页面读取 ---------------- */
  /**
   * 探测联机牌局状态。牌局组件 props 形如 {view, count, position, room, headText, send, isTurn,...}
   * （逆向自 ddz chunk：view = DDZGameData 解码并展开后的对象，含 cardPositionList/playerCardLists/lastCards；
   *   myPos 取 room.position（我坐的座位，0 基）+1；某座位组件的 position 只是该座位下标不是我的座位）。
   *   state：0=叫地主，1..n=轮到玩家n，9..12=玩家N胜；status 内玩家号 1 基。
   */
  function readGame() {
    const build = p => {
      const v = p.view;
      // 人数：room.playerList 最准（view.v 是版本号不是人数！）
      const n = (p.room && Array.isArray(p.room.playerList) && p.room.playerList.length >= 2)
        ? p.room.playerList.length : 3;
      const hasDerived = Array.isArray(v.playerCardLists) && v.playerCardLists.length > 1 && v.lastCards !== undefined;
      const st = hasDerived ? v : E.expandState(v, n);
      // 我的座位：room.position 已是 1 基（实测 room.position=2 = 我的手牌命中 playerCardLists[2]）
      let myPos = null;
      if (p.room && typeof p.room.position === 'number') myPos = p.room.position;
      else if (typeof p.position === 'number') myPos = p.position;   // 座位组件的 position 同样 1 基
      return { st, myPos, n, props: p };
    };
    const hit = test => pp => pp && pp.view && pp.view.cardPositionList != null;   // 宽容：接受数组或对象
    // 1) 优先从自己手牌附近（.ddz-poker）找——手牌组件父级链通常带 view
    for (const el of document.querySelectorAll('.ddz-poker, .ddz-poker-list')) {
      const p = HQ.findProps(el, hit(), 20);
      if (p && Array.isArray(p.view.cardPositionList)) return build(p);
    }
    // 2) 兜底：遍历所有元素找带 view 的组件（fiber 跳层放宽，避免嵌套过深漏掉）
    const root = document.getElementById('root') || document.body;
    if (!root) return null;
    for (const el of root.querySelectorAll('div,section')) {
      const p = HQ.findProps(el, hit(), 20);
      if (p && p.view && Array.isArray(p.view.cardPositionList)) return build(p);
    }
    return null;
  }

  // 兼容旧名
  const readMinState = readGame;

  /* ---------------- 手牌 DOM / 操作按钮 ---------------- */
  const clickEl = HQ.clickEl, sleep = HQ.sleep;

  /** 手牌 DOM：div#牌id.ddz-poker（模块 6139 牌组件 id=牌号）。返回 Map<牌id, el> */
  function readCardEls() {
    const map = new Map();
    for (const el of document.querySelectorAll('.ddz-poker[id]')) {
      const id = +el.getAttribute('id');
      if (id >= 1 && id <= 108) map.set(id, el);   // 108 上限兼容两副牌
    }
    return map;
  }

  function findBtnByText(re) {
    for (const b of document.querySelectorAll('button')) {
      if (re.test((b.textContent || '').trim())) return b;
    }
    return null;
  }

  /** 点选若干张牌并按出牌/过按钮 */
  async function playCards(cardIds) {
    const els = readCardEls();
    if (!cardIds || !cardIds.length) {
      const pass = findBtnByText(/(?:过|不出|不要)$/);
      if (pass) { clickEl(pass); return true; }
      return false;
    }
    for (const id of cardIds) {
      const el = els.get(E.normId(id));
      if (el) { clickEl(el); await sleep(80); }
    }
    await sleep(150);
    const play = findBtnByText(/出牌$/);
    if (!play) return false;
    clickEl(play);
    return true;
  }

  /* ---------------- 高亮（提示建议牌） ---------------- */
  let overlay = null;
  function highlightCards(cardIds) {
    const els = readCardEls();
    if (overlay) { HQ.removeOverlay(overlay); overlay = null; }
    if (!cardIds || !cardIds.length) return;
    for (const id of cardIds) {
      const el = els.get(E.normId(id));
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const ov = document.createElement('div');
      ov.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #38bdf8;border-radius:6px;pointer-events:none;z-index:9998;box-shadow:0 0 8px rgba(56,189,248,.6);`;
      (overlay = overlay || document.createElement('div')).appendChild(ov);
    }
    if (overlay && !overlay.parentNode) {
      overlay.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:9998;';
      document.body.appendChild(overlay);
    }
  }

  /* ---------------- 主循环 ---------------- */
  let busy = false;
  let hintCache = { key: '', result: null };

  async function tick() {
    const onRoute = /\/ddz/.test(location.pathname);
    if (panelEl) panelEl.style.display = onRoute ? '' : 'none';
    if (!onRoute) return;
    if (busy) return;

    const game = readGame();
    if (!game) { setInfo('未检测到斗地主对局（进入房间开局后工作）'); renderCounter(null); return; }
    const n = game.n;
    const st = game.st;
    const myPos = game.myPos;
    const mode = n < 4;                       // 牌型集与人数挂钩（6139 的 e 参数）
    const myHand = myPos ? (st.playerCardLists[myPos] || []) : [];

    // 终局
    if (st.isFinish) {
      setInfo(`🎉 玩家${st.winner}获胜（${st.landlordWin ? '地主' : '农民'}胜）`);
      renderCounter(st, myHand, mode);
      return;
    }

    // 我的回合？（state 1..n = 轮到玩家 state）
    const myTurn = myPos != null && st.state === myPos;
    const isLandlord = myPos === st.landlordId;

    // 记牌器
    if (settings.counter) renderCounter(st, myHand, mode);

    // 叫地主阶段（state 0 = 所有人可叫/抢）
    if (st.state === 0) {
      const ev = myPos != null && myHand.length ? E.shouldBid(myHand, n) : null;
      const desc = ev
        ? `叫地主：${ev.bid ? '建议叫/抢 👍' : '建议不叫'}（牌力 ${ev.score}/${ev.threshold}）`
        : '叫地主阶段（观战中）';
      // 托管：无论叫不叫都要点按钮，否则牌局卡住
      if (!settings.auto || !ev || !myHand.length) { setInfo(desc); return; }
      busy = true;
      try {
        await sleep(600 + Math.random() * 800);
        const game2 = readGame();
        if (!game2 || game2.st.state !== 0) return;
        const btn = findBtnByText(ev.bid ? /(?:叫地主|抢地主)$/ : /(?:不叫|不抢)$/);
        if (btn) {
          clickEl(btn);
          setInfo(ev.bid ? `AI已叫/抢（牌力 ${ev.score}）` : `AI不叫（牌力 ${ev.score}）`);
        } else setInfo(desc + '（按钮未找到）');
      } catch (err) { console.error('[斗地主AI]', err); } finally { busy = false; }
      return;
    }

    if (!myTurn || !myHand.length) { setInfo(st.state === 0 ? '等待…' : `等待玩家${st.state}出牌…`); return; }

    // 出牌决策
    const lastFrom = st._lastFrom || (st.lastCards.length ? (st.state === 1 ? n : st.state - 1) : 0);
    // lastFrom 推断：轮到我(state)，出牌者为 state-1（绕回取 n）——上家；若连过多人则不准，仅用于队友判断
    const oppMin = Math.min(
      ...[1, 2, 3, 4].filter(i => i <= n && i !== myPos && (isLandlord || i !== st.landlordId))
        .map(i => st.playerRestCardCounts[i]),
    );
    const mates = !isLandlord && st.landlordId ? [st.landlordId] : [];   // 农民的对手是地主
    const lastFromTeammate = !isLandlord && lastFrom !== 0 && lastFrom !== st.landlordId;

    const key = JSON.stringify([st.cardPositionList, st.playedCardList, st.state, myPos, settings.auto]);
    let play;
    if (hintCache.key === key) play = hintCache.result;
    else {
      if (!st.lastCards.length) play = E.leadPlay(myHand, mode, { oppMin });
      else {
        play = E.followPlay(myHand, st.lastCards, mode, {
          isLandlord, lastFromTeammate, oppMin,
        });
      }
      hintCache = { key, result: play };
    }

    if (settings.hint) highlightCards(play);

    if (!settings.auto) {
      const desc = play ? `建议：${play.map(c => E.rankName(E.rankOf(c))).join(' ')}` : '建议：过（不出）';
      setInfo(`${st.lastCards.length ? '压牌' : '领出'} | ${desc} | 我${myHand.length}张`);
      return;
    }

    busy = true;
    try {
      await sleep(500 + Math.random() * 700);
      const game2 = readGame();
      if (!game2) return;
      const st2 = game2.st;
      if (st2.isFinish || st2.state !== myPos) return;
      const r = await playCards(play);
      setInfo(r ? (play ? `AI已出：${play.map(c => E.rankName(E.rankOf(c))).join(' ')}` : 'AI已过') : '⚠ 操作按钮未找到');
    } catch (err) {
      console.error('[斗地主AI]', err);
    } finally { busy = false; }
  }

  /* ---------------- UI ---------------- */
  let panelEl = null, infoEl = null, counterEl = null;
  function setInfo(t) { if (infoEl) infoEl.textContent = t; }

  function renderCounter(st, myHand, mode) {
    if (!counterEl) return;
    if (!st) { counterEl.innerHTML = '<div class="cc-empty">—</div>'; return; }
    // 底牌过滤：已打出的牌（pos&=8 后仍带位3）不算「未现」，避免与 playedCardList 重复计数
    const playedSet = new Set(st.playedCardList.filter(x => x > 0));
    const holeUnplayed = st.isFinish ? [] : st.holeCardList.filter(c => !playedSet.has(c));
    const rem = E.remainingRanks(myHand || [], [...playedSet], holeUnplayed, 1);
    // 经典记牌器顺序：王王2AKQJ10…3；0 张的置灰
    const order = [54, 53, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3];
    counterEl.innerHTML = order.map(r => {
      const n = rem.get(r) || 0;
      const cls = 'cc' + (n === 0 ? ' cc0' : '') + (r === 54 ? ' ccR' : '');
      const face = r === 54 || r === 53 ? '王' : E.rankName(r);
      return `<span class="${cls}" title="${E.rankName(r)}"><i>${face}</i><b>${n}</b></span>`;
    }).join('');
  }

  function buildPanel(container) {
    if (panelEl) return;
    const style = document.createElement('style');
    style.textContent = `
      #ddzAI{width:230px;background:rgba(15,23,42,.93);
        color:#e2e8f0;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;border-radius:12px;
        box-shadow:0 6px 24px rgba(0,0,0,.35);user-select:none;backdrop-filter:blur(4px)}
      #ddzAI .hd{display:flex;align-items:center;justify-content:space-between;padding:7px 10px 5px;cursor:move;font-weight:600}
      #ddzAI .bd{padding:0 10px 10px}
      #ddzAI.min .bd{display:none}
      #ddzAI button{cursor:pointer;border:none;border-radius:7px;padding:4px 0;font-size:12px;flex:1;background:#334155;color:#cbd5e1}
      #ddzAI button.on{background:#3b82f6;color:#fff;font-weight:600}
      #ddzAI .row{display:flex;gap:6px;margin-top:7px;align-items:center}
      #ddzAI .counter{margin-top:7px;padding:5px 5px 4px;background:#1e293b;border-radius:7px}
      #ddzAI .cc{display:inline-flex;flex-direction:column;align-items:center;width:12.1%;min-width:20px;margin:1.5px 0.5%;
        background:#0f172a;border:1px solid #334155;border-radius:4px;padding:2px 0;line-height:1.15;vertical-align:top}
      #ddzAI .cc i{font-style:normal;font-size:9.5px;color:#94a3b8}
      #ddzAI .cc b{font-size:12.5px;font-weight:700;color:#f1f5f9}
      #ddzAI .ccR i,#ddzAI .ccR b{color:#f87171}
      #ddzAI .cc0{opacity:.28}
      #ddzAI .cc-empty{color:#64748b;min-height:22px;line-height:1.7}
      #ddzAI .info{margin-top:7px;padding-top:6px;border-top:1px solid #334155;color:#94a3b8;min-height:30px;word-break:break-all}
      #ddzAI .x{cursor:pointer;color:#64748b;font-size:14px;padding:0 2px}
    `;
    document.head.appendChild(style);
    panelEl = document.createElement('div');
    panelEl.id = 'ddzAI';
    panelEl.innerHTML = `
      <div class="hd"><span>🃏 斗地主 AI</span><span class="x">—</span></div>
      <div class="bd">
        <div class="row">
          <button data-t="counter">📋 记牌器</button>
          <button data-t="hint">💡 提示</button>
          <button data-t="auto">🤖 托管</button>
        </div>
        <div class="counter">—</div>
        <div class="info">等待对局…</div>
      </div>`;
    (container || document.body).appendChild(panelEl);
    infoEl = panelEl.querySelector('.info');
    counterEl = panelEl.querySelector('.counter');
    panelEl.querySelectorAll('button[data-t]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.t;
        settings[t] = !settings[t];
        saveSettings(); renderPanel();
      });
    });
    panelEl.querySelector('.x').addEventListener('click', () => panelEl.classList.toggle('min'));
        renderPanel();
  }

  function renderPanel() {
    if (!panelEl) return;
    panelEl.querySelectorAll('button[data-t]').forEach(b => b.classList.toggle('on', !!settings[b.dataset.t]));
  }

  /* ---------------- 启动 ---------------- */
  /* ---------------- 注册（壳负责挂载与调度） ---------------- */
  HQ.registerGame({
    id: 'ddz', name: '斗地主', icon: '🃏', interval: 500, dragIgnore: 'x',
    route: /\/ddz/,
    mount(container) {
      buildPanel(container);
      return panelEl.querySelector('.hd');
    },
    tick: () => tick(),
  });
  console.log('[斗地主AI] 已注册 ✓ 记牌器默认开启');

  /* ---------------- 调试接口 ---------------- */
  self.__ddzAI = {
    dump: () => {
      const game = readGame();
      if (!game) {
        // 诊断：列出页面带 view 的组件与带 .ddz-poker 的元素数量
        let views = 0, poker = 0;
        const sample = {};
        const root = document.getElementById('root') || document.body;
        for (const el of root.querySelectorAll('div,section')) {
          const p = HQ.findProps(el, pp => pp && pp.view && pp.view.cardPositionList != null, 20);
          if (p) {
            views++;
            if (!sample.keys) sample.keys = Object.keys(p).slice(0, 12);
            if (!sample.viewKeys) sample.viewKeys = Object.keys(p.view || {}).slice(0, 16);
          }
          if (el.className && String(el.className).indexOf('ddz-poker') >= 0) poker++;
        }
        return {
          found: false,
          pokerEls: poker, viewComponents: views, sample,
          bodyHasCardDiv: !!document.querySelector('.ddz-poker'),
        };
      }
      const { st, myPos, n, props } = game;
      return {
        found: true,
        view: st, myPos, players: n,
        propsKeys: Object.keys(props || {}),
        myHand: myPos ? st.playerCardLists[myPos] : null,
        lastCards: st.lastCards, canPlayAny: st.canPlayAnyCards,
        stateIsFinish: st.isFinish, stateVal: st.state,
      };
    },
    play: cardIds => playCards(cardIds),
    suggest: () => {
      const game = readGame();
      if (!game) return null;
      const { st, myPos, n } = game;
      const myHand = myPos ? st.playerCardLists[myPos] : [];
      return st.lastCards.length
        ? E.followPlay(myHand, st.lastCards, n < 4, {})
        : E.leadPlay(myHand, n < 4, {});
    },
    settings,
  };
})();
