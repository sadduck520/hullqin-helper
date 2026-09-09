// ==UserScript==
// @name         斗地主 AI 助手（game.hullqin.cn）
// @namespace    ddz-ai-helper
// @version      1.0.0
// @description  桌游合集斗地主的 AI 助手：📋记牌器 + 💡出牌提示 + 🤖托管出牌（启发式：最少手数拆牌/身份配合/炸弹时机）；牌型判定 1:1 逆向自游戏源码；支持 2/3/4 人。朋友间娱乐使用。
// @author       Eve
// @match        https://game.hullqin.cn/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==
(function () {
/* ============================================================
 * hullqin-shared · React Fiber 工具
 * game.hullqin.cn 是 React SPA，游戏状态挂在各组件的 fiber memoizedProps 上。
 * 用法：HQ.findProps(el, p => typeof p.pos === 'number', 4)
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  HQ.getFiber = function (el) {
    for (const k in el) if (k.indexOf('__reactFiber') === 0) return el[k];
    return null;
  };

  /**
   * 从元素出发沿 fiber.return 向上找第一个满足 test 的 memoizedProps
   * @param {Element} el 页面元素
   * @param {(p: object) => boolean} test
   * @param {number} [maxHop=6] 最多向上跳几层
   */
  HQ.findProps = function (el, test, maxHop) {
    let f = HQ.getFiber(el);
    for (let h = 0; f && h <= (maxHop || 6); h++) {
      const p = f.memoizedProps;
      if (p && test(p)) return p;
      f = f.return;
    }
    return null;
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 页面操作通用件：模拟点击 / 等待 / 提示浮层
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  /** 对元素派发一个真实 bubbles 的 click（React 的 onClick 能收到） */
  HQ.clickEl = function (el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };

  HQ.sleep = ms => new Promise(r => setTimeout(r, ms));

  /** DOM 就绪后执行 fn（站点为 SPA，脚本可能在任意时机注入） */
  HQ.onReady = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  };

  /**
   * 顶部居中提示浮层（2.6s 后淡出）
   * @param {string} msg 文案
   * @param {string} [cls] class 名（每个助手用自己的，避免互相复用同一个节点）
   */
  HQ.toast = function (msg, cls) {
    cls = cls || 'hq-ai-toast';
    let t = document.querySelector('.' + cls);
    if (!t) {
      t = document.createElement('div');
      t.className = cls;
      t.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;background:rgba(15,23,42,.92);color:#e2e8f0;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 棋盘高亮覆盖层
 * 独立 svg，fixed 定位盖在游戏棋盘上，pointer-events:none 不挡操作；
 * scroll/resize 自动重新贴合棋盘位置。
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};
  const SVGNS = 'http://www.w3.org/2000/svg';
  const live = new Set();
  let listening = false;

  function listen() {
    if (listening) return;
    listening = true;
    const refitAll = () => { for (const ov of live) if (ov.__fit) ov.__fit(); };
    window.addEventListener('scroll', refitAll, { passive: true });
    window.addEventListener('resize', refitAll, { passive: true });
  }

  /**
   * 创建一个与目标 svg 对齐的覆盖层
   * @param {SVGSVGElement} svg 游戏棋盘 svg
   * @param {string} viewBox 覆盖层使用的坐标系（通常与棋盘一致）
   */
  HQ.createOverlay = function (svg, viewBox) {
    listen();
    const ov = document.createElementNS(SVGNS, 'svg');
    ov.setAttribute('viewBox', viewBox);
    ov.style.cssText = 'position:fixed;pointer-events:none;z-index:9998;';
    ov.__fit = () => {
      const r = svg.getBoundingClientRect();
      ov.style.left = r.left + 'px';
      ov.style.top = r.top + 'px';
      ov.style.width = r.width + 'px';
      ov.style.height = r.height + 'px';
    };
    ov.__fit();
    document.body.appendChild(ov);
    live.add(ov);
    return ov;
  };

  /** 清空覆盖层内容（保留元素，下次可直接复用） */
  HQ.clearOverlay = function (ov) {
    if (ov) while (ov.firstChild) ov.removeChild(ov.firstChild);
  };

  /** 彻底移除覆盖层并解除跟踪 */
  HQ.removeOverlay = function (ov) {
    if (!ov) return;
    live.delete(ov);
    ov.remove();
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 设置存取 + 面板拖动
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  /** 从 localStorage 读取设置（JSON），与 defaults 合并，解析失败静默回退 */
  HQ.loadSettings = function (key, defaults) {
    const s = { ...defaults };
    try { Object.assign(s, JSON.parse(localStorage.getItem(key) || '{}')); } catch (e) { }
    return s;
  };

  HQ.saveSettings = function (key, settings) {
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch (e) { }
  };

  /**
   * 让面板可被按住标题栏拖动
   * @param {HTMLElement} panelEl 面板根元素（移动其 left/top，right 置 auto）
   * @param {Element} handleEl 拖动手柄（如标题栏）
   * @param {string} [ignoreClass] 手柄内带此 class 的子元素不触发拖动（如收起按钮）
   */
  HQ.makeDraggable = function (panelEl, handleEl, ignoreClass) {
    let dragging = null;
    handleEl.addEventListener('mousedown', e => {
      if (ignoreClass && e.target.classList.contains(ignoreClass)) return;
      const r = panelEl.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      panelEl.style.left = Math.max(0, e.clientX - dragging.dx) + 'px';
      panelEl.style.top = Math.max(0, e.clientY - dragging.dy) + 'px';
      panelEl.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = null; });
  };
})(typeof self !== 'undefined' ? self : globalThis);

/* ============================================================
 * hullqin-shared · 游戏注册表 + 独立版壳
 *
 * 每个游戏桥接文件通过 HQ.registerGame 注册自己：
 *   HQ.registerGame({
 *     id: 'wzq', name: '五子棋', icon: '⚫',
 *     route: /\/wzq/,              // 路由门禁（SPA pathname）
 *     interval: 450,               // tick 间隔 ms（可选，默认 450）
 *     dragIgnore: 'x',             // 标题栏内拖动忽略的元素 class（可选）
 *     canShow: () => bool,         // 可选：面板显示条件（如斗兽棋需检测到棋盘）
 *     mount(container) {...},      // 把面板渲染进 container，返回标题栏元素（供拖动）
 *     tick() {...},                // 主循环一步
 *   });
 *
 * 两种壳二选一：
 *   - 独立版：build 时在末尾追加 `HQ.mountStandalone();`
 *   - 整合版：统一 GUI 壳遍历 HQ.games 按路由挂载
 * ============================================================ */
(function (root) {
  'use strict';
  const HQ = root.HQ = root.HQ || {};

  HQ.games = HQ.games || [];
  HQ.registerGame = function (mod) { HQ.games.push(mod); };

  /** 独立版壳：把当前路由对应的游戏面板挂到固定位置容器（右上角） */
  HQ.mountStandalone = function () {
    HQ.onReady(function () {
      const g = HQ.games.find(x => x.route && x.route.test(location.pathname));
      if (!g) return;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;';
      document.body.appendChild(wrap);
      const hd = g.mount(wrap);
      if (hd && HQ.makeDraggable) HQ.makeDraggable(wrap, hd, g.dragIgnore);
      const sync = () => { if (g.canShow) wrap.style.display = g.canShow() ? '' : 'none'; };
      sync();
      setInterval(function () { sync(); g.tick(); }, g.interval || 450);
      console.log('[HQ助手] ' + g.name + ' 已加载 ✓');
    });
  };
})(typeof self !== 'undefined' ? self : globalThis);

/**
 * 斗地主引擎核心 —— 牌型判定 1:1 复刻自 game.hullqin.cn 前端（ddz chunk 模块 6139 的 L/T/A/R/g）
 * 决策层（叫地主/拆牌/出牌/配合）为自研启发式。
 *
 * 牌表示：id 1-54。1-52 = 四种花色×13 张（rank 3..14=A,15=2），53=大王，54=小王
 *   rank 表 f[id]：3,4,...,14(A),15(2)；53→54，54→53（大>小）
 *   （与站点一致：sortKey d 用 rank+花色小数保证展示顺序稳定）
 *
 * 牌型（与站点 Type 枚举一致）：
 *   Bad=0 One=1 Pair=2 Three=3 ThreeWithOne=4 ThreeWithPair=5
 *   FourWithOnes=6 FourWithPairs=7 Four=100 Jokers=127
 *   顺子/连对/飞机的长度编码在 type 高位（One|(len-4)<<3 等）
 *
 * 模式参数 mode（与站点一致，= 玩家数<4）：
 *   true  = 2/3 人斗地主：王炸、三带一、四带二、飞机带翅
 *   false = 4 人掼蛋变体：无上述牌型
 * 本文件不依赖 DOM，可在 Node 中测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DDZEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===== 牌基础（复刻 6139 的 d/f 表与工具）=====
  const RANK = [0, 14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    14, 15, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 54, 53];
  const normId = e => (e - 1) % 54 + 1;         // 多副牌归一化
  const rankOf = e => RANK[normId(e)];
  const cntMap = cards => {
    const m = new Map();
    for (const c of cards) { const r = rankOf(c); m.set(r, (m.get(r) || 0) + 1); }
    return m;
  };
  /** 逻辑排序（1:1 复刻 x）：张数降序，同张数按 rank 升序（首元素=最小主力 rank）*/
  function sortHand(cards) {
    const m = cntMap(cards);
    return [...cards].sort((a, b) => {
      const ca = m.get(rankOf(a)), cb = m.get(rankOf(b));
      return ca === cb ? rankOf(a) - rankOf(b) : cb - ca;
    });
  }

  // ===== 牌型解析（1:1 复刻 L）=====
  const Bad = 0, One = 1, Pair = 2, Three = 3, ThreeWithOne = 4, ThreeWithPair = 5,
    FourWithOnes = 6, FourWithPairs = 7, Four = 100, Jokers = 127;

  /**
   * @param {boolean} mode 人数<4（斗地主牌型集）
   * @param {number[]} cards 牌 id 数组
   * @returns {[number, number]} [type, rank]；Bad 时 rank 无意义
   */
  function parseCards(mode, cards) {
    const r = cards.length;
    if (!r) return [Bad, 0];
    const sorted = sortHand(cards);
    const m = cntMap(sorted);
    const hi = rankOf(sorted[0]), lo = rankOf(sorted[r - 1]);
    const o = m.get(hi), c = m.get(lo);

    if (o === r) {                                   // 全同 rank
      if (r < 4) return [r, hi];                     // 1单 2对 3三
      return [Four - 4 + r, hi];                     // 4=炸弹（多副牌 5+ 同 rank 为 101+）
    }
    if (o === 1) {                                   // 全单张
      if (mode && r === 2 && hi > 50) return [Jokers, 0];    // 王炸（原站不带 rank）
      if (r < 5 || sorted.some(e => rankOf(e) > 14)) return [Bad, 0];
      return sorted.every((e, t) => rankOf(e) === hi + t)
        ? [One | (r - 4) << 3, hi] : [Bad, 0];       // 顺子
    }
    if (o === 2) {                                   // 对子体系
      if (!mode && r === 4 && hi > 50 && c === 2) return [Jokers, 0];  // 掼蛋双王炸(4张)
      if (c < 2 || r < 6 || sorted.some(e => rankOf(e) > 14)) return [Bad, 0];
      return sorted.every((e, t) => t % 2 || rankOf(e) === hi + t / 2)
        ? [Pair | (r - 2) << 2, hi] : [Bad, 0];      // 连对
    }
    if (o === 3) {
      if (c === 3 && sorted.every(e => rankOf(e) <= 14)
        && sorted.every((e, t) => t % 3 || rankOf(e) === hi + t / 3))
        return [Three | (r / 3 - 1) << 3, hi];       // 飞机（纯）
      if (r === 4) return mode ? [ThreeWithOne, hi] : [Bad, 0];
      if (r === 5 && c === 2) return [ThreeWithPair, hi];
    }
    if (o === 4 && mode) {
      if (r === 6) return [FourWithOnes, hi];        // 四带二单
      if (r === 8) {
        if (c === 2) return [FourWithPairs, hi];     // 四带两对
        if (c === 4) return [FourWithPairs, lo];     // 带两对（取小对判定? 与原站一致用 lo）
      }
    }
    // 飞机带对：c>1 && r%5===0 && r>5（复刻原逻辑：找最长连续三张组，翅膀为对）
    if (c > 1 && r % 5 === 0 && r > 5) {
      const n = r / 5;
      const set3 = new Set();
      m.forEach((cnt, rk) => { if (cnt > 2 && rk < 15) set3.add(rk); });
      if (set3.size >= n) {
        const starts = [];
        set3.forEach(rk => {
          if (Array.from({ length: n }, (_, k) => rk + k).every(x => set3.has(x))) starts.push(rk);
        });
        starts.sort((a, b) => b - a);
        for (const st of starts) {
          const rem = new Map(m);
          for (let k = 0; k < n; k++) rem.set(st + k, rem.get(st + k) - 3);
          if ([...rem.values()].every(v => v % 2 === 0)) {
            // 剩余全为偶数（可作对子翅膀）→ 三带二飞机
            let allEven = true;
            rem.forEach((v, rk) => { if (v % 2) allEven = false; });
            if (allEven) return [ThreeWithPair | (n - 1) << 3, st];
          }
        }
      }
    }
    // 飞机带单：mode && r%4===0 && r>4（复刻：连续三张组 + 单张翅膀）
    if (mode && r % 4 === 0 && r > 4) {
      const n = r / 4;
      const set3 = new Set();
      m.forEach((cnt, rk) => { if (cnt > 2 && rk < 15) set3.add(rk); });
      if (set3.size >= n) {
        const starts = [];
        set3.forEach(rk => {
          if (Array.from({ length: n }, (_, k) => rk + k).every(x => set3.has(x))) starts.push(rk);
        });
        if (starts.length) {
          starts.sort((a, b) => b - a);
          return [ThreeWithOne | (n - 1) << 3, starts[0]];
        }
      }
    }
    return [Bad, 0];
  }

  /** 能否压住（1:1 复刻 T 的比较） */
  function canBeat(mode, cards, lastCards) {
    const [t, r] = parseCards(mode, cards);
    if (!t) return false;
    if (!lastCards || !lastCards.length) return true;
    const [lt, lr] = parseCards(mode, lastCards);
    if (!lt) return true;                    // 对方非法（无规则出的牌）→ 可压
    if (lt === t) return r > lr;             // 同型比大小（长度已编码进 type）
    return t >= Four && t > lt;              // 我方炸弹压非炸
  }

  // ===== 手牌拆解（启发式：双策略取优）=====
  /**
   * 把手牌拆成组合列表，手数尽量少。返回 [{cards, type, rank}]。
   * 策略A：王炸/炸弹原样保留；策略B：炸弹拆散参与顺子/三带。
   * 两策略都跑一遍，选手数少者（同手数优先 A，炸弹终局价值高）。
   */
  function decompose(hand, mode) {
    const a = decomposeInner(hand, mode, true);
    const b = decomposeInner(hand, mode, false);
    return b.length < a.length ? b : a;
  }

  function decomposeInner(hand, mode, keepBombs) {
    // 按 rank 聚合
    const byRank = new Map();
    for (const c of hand) {
      const r = rankOf(c);
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(c);
    }
    const combos = [];
    const used = new Set();
    if (keepBombs) {
      // 1. 王炸 / 炸弹保留
      if (mode) {
        const j1 = hand.find(c => normId(c) === 53), j2 = hand.find(c => normId(c) === 54);
        if (j1 !== undefined && j2 !== undefined) {
          combos.push({ cards: [j1, j2], type: Jokers, rank: 54 });
          used.add(j1); used.add(j2);
        }
      }
      for (const [r, cs] of byRank) {
        if (cs.length === 4 && r < 15) {
          if (!cs.some(c => used.has(c))) { combos.push({ cards: [...cs], type: Four, rank: r }); cs.forEach(c => used.add(c)); }
        }
      }
    }
    const rest = hand.filter(c => !used.has(c));
    // 2. 顺子（≥5，越长越好，尽量用单张多的）
    const takeStraight = () => {
      const cnt = new Map();
      for (const c of rest) { const r = rankOf(c); if (r <= 14) cnt.set(r, (cnt.get(r) || 0) + 1); }
      // 找最长连续段（每 rank 至少1张）
      let best = null;
      for (let lo = 3; lo <= 10; lo++) {
        let hi = lo;
        while (hi <= 14 && cnt.get(hi)) hi++;
        const len = hi - lo;
        if (len >= 5 && (!best || len > best.len)) best = { lo, len };
      }
      if (!best) return false;
      const cards = [];
      const consumed = new Map();
      for (let r = best.lo; r < best.lo + best.len; r++) {
        const c = rest.find(x => rankOf(x) === r && !consumed.has(x));
        cards.push(c); consumed.set(c, 1);
      }
      cards.forEach(c => { rest.splice(rest.indexOf(c), 1); });
      const [t, rk] = parseCards(mode, cards);
      combos.push({ cards, type: t, rank: rk });
      return true;
    };
    // 只在单张较多时拆顺子（避免拆散对/三）
    let singles = 0;
    { const m = cntMap(rest); m.forEach((v, r) => { if (v === 1 && r <= 14) singles++; }); }
    if (singles >= 4) { takeStraight(); takeStraight(); }
    // 3. 连对（≥3 连）
    {
      const pairsByRank = new Map();
      const m = cntMap(rest);
      m.forEach((v, r) => { if (v >= 2 && r <= 14 && r >= 3) pairsByRank.set(r, v); });
      let lo = 3;
      while (lo <= 12) {
        if (pairsByRank.get(lo) >= 2 && pairsByRank.get(lo + 1) >= 2 && pairsByRank.get(lo + 2) >= 2) {
          let hi = lo;
          while (hi + 1 <= 14 && pairsByRank.get(hi + 1) >= 2) hi++;
          const cards = [];
          for (let r = lo; r <= hi; r++) {
            const cs = rest.filter(x => rankOf(x) === r);
            cards.push(cs[0], cs[1]);
          }
          cards.forEach(c => rest.splice(rest.indexOf(c), 1));
          const [t, rk] = parseCards(mode, cards);
          combos.push({ cards, type: t, rank: rk });
          lo = hi + 1;
        } else lo++;
      }
    }
    // 4. 三张（带一/带对）
    {
      const m = cntMap(rest);
      const threes = [];
      m.forEach((v, r) => { if (v >= 3 && r < 15) threes.push(r); });
      threes.sort((a, b) => a - b);
      for (const r of threes) {
        const cs = rest.filter(x => rankOf(x) === r);
        if (cs.length < 3) continue;
        const trio = cs.slice(0, 3);
        trio.forEach(c => rest.splice(rest.indexOf(c), 1));
        // 翅膀：优先拆最差的单/对（不拆炸弹/王）
        let wing = null;
        if (mode) {
          const s = rest.find(c => rankOf(c) < 15 || rest.filter(x => rankOf(x) === rankOf(c)).length === 1);
          if (s !== undefined) { wing = [s]; rest.splice(rest.indexOf(s), 1); }
        }
        const cards = wing ? trio.concat(wing) : trio;
        const [t, rk] = parseCards(mode, cards);
        combos.push({ cards, type: t, rank: rk });
      }
    }
    // 5. 剩余对子/单张
    {
      const m = cntMap(rest);
      const done = new Set();
      for (const c of sortHand(rest)) {
        if (done.has(c)) continue;
        const r = rankOf(c);
        const cs = rest.filter(x => rankOf(x) === r);
        if (cs.length >= 2) {
          combos.push({ cards: [cs[0], cs[1]], type: Pair, rank: r });
          done.add(cs[0]); done.add(cs[1]);
        } else {
          combos.push({ cards: [c], type: One, rank: r });
          done.add(c);
        }
      }
    }
    return combos;
  }

  /** 手数（组合数）*/
  const handCount = (hand, mode) => decompose(hand, mode).length;

  // ===== 决策 =====
  /**
   * 叫地主评估：返回 {bid: 是否建议叫, score: 手牌强度分}
   * 计分：大王4 小王3 每个2计2 每个 A 计1 炸弹+3 王炸再+3
   * 2 人局底牌多（20/54 张），做地主收益更高 → 阈值更低
   */
  function shouldBid(hand, players) {
    let sc = 0;
    const m = cntMap(hand);
    if (m.get(54)) sc += 4;
    if (m.get(53)) sc += 3;
    sc += (m.get(15) || 0) * 2;
    sc += (m.get(14) || 0) * 1;
    m.forEach((v, r) => { if (v === 4 && r < 15) sc += 3; });
    if (m.get(54) && m.get(53)) sc += 3;     // 王炸
    const threshold = players === 2 ? 6 : players === 4 ? 9 : 8;
    return { bid: sc >= threshold, score: sc, threshold };
  }

  /**
   * 生成能压住 lastCards 的所有最小候选（同型 + 炸弹 + 王炸）
   * @returns {number[][]} 候选牌数组列表（按代价升序：先同型最小，后炸弹）
   */
  function genFollows(hand, lastCards, mode) {
    const [lt, lr] = parseCards(mode, lastCards || []);
    const byRank = new Map();
    for (const c of hand) {
      const r = rankOf(c);
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(c);
    }
    const out = [];
    const base = lt & 7 || lt;                 // 基础牌型（低3位）
    if (lt === Bad || !lastCards || !lastCards.length) return out;

    const pickN = (r, n) => byRank.get(r).slice(0, n);

    if (lt >= Four || lt === Jokers) {
      // 对方是炸：只能更大的炸/王炸
    } else if (base === One && lt < 8) {        // 单张
      for (const [r, cs] of byRank) if (r > lr && r <= 54 && cs.length < 4) out.push([cs[0]]);
    } else if (base === Pair && lt < 16) {      // 对子（lt 编码: 2|(len-2)<<2, len=2 → 2）
      for (const [r, cs] of byRank) if (r > lr && cs.length >= 2 && cs.length < 4) out.push(cs.slice(0, 2));
    } else if (lt === Three) {                  // 三张（几乎不出现在 lastCards）
      for (const [r, cs] of byRank) if (r > lr && cs.length === 3) out.push(cs.slice(0, 3));
    } else if (lt === ThreeWithOne) {
      for (const [r, cs] of byRank) if (r > lr && cs.length >= 3) {
        const trio = cs.slice(0, 3);
        for (const [r2, cs2] of byRank) if (r2 !== r && cs2.length < 4) { out.push(trio.concat([cs2[0]])); break; }
      }
    } else if (lt === ThreeWithPair) {
      for (const [r, cs] of byRank) if (r > lr && cs.length >= 3) {
        const trio = cs.slice(0, 3);
        for (const [r2, cs2] of byRank) if (r2 !== r && cs2.length >= 2 && cs2.length < 4) { out.push(trio.concat(cs2.slice(0, 2))); break; }
      }
    } else if (lt === FourWithOnes || lt === FourWithPairs) {
      // 极少跟；跳过（用炸弹即可）
    } else if (lt >= One + (1 << 3) && lt < Pair) {   // 顺子
      const len = ((lt - One) >> 3) + 4;
      for (let lo = lr + 1; lo + len - 1 <= 14; lo++) {
        const cards = [];
        let ok = true;
        for (let r = lo; r < lo + len; r++) {
          const cs = byRank.get(r);
          if (!cs || !cs.length) { ok = false; break; }
          cards.push(cs[0]);
        }
        if (ok) out.push(cards);
      }
    } else if (lt >= Pair + (1 << 2) && lt < Three) { // 连对
      const len = ((lt - Pair) >> 2) + 2;
      for (let lo = lr + 1; lo + len - 1 <= 14; lo++) {
        const cards = [];
        let ok = true;
        for (let r = lo; r < lo + len; r++) {
          const cs = byRank.get(r);
          if (!cs || cs.length < 2) { ok = false; break; }
          cards.push(cs[0], cs[1]);
        }
        if (ok) out.push(cards);
      }
    } else if (lt >= Three + (1 << 3) && lt < ThreeWithOne) {  // 纯飞机
      const n = ((lt - Three) >> 3) + 1;
      for (let lo = lr + 1; lo + n - 1 <= 14; lo++) {
        const cards = [];
        let ok = true;
        for (let r = lo; r < lo + n; r++) {
          const cs = byRank.get(r);
          if (!cs || cs.length < 3) { ok = false; break; }
          cards.push(...cs.slice(0, 3));
        }
        if (ok) out.push(cards);
      }
    } else if (lt >= ThreeWithOne + (1 << 3) && lt < ThreeWithPair) {  // 飞机带单
      const n = ((lt - ThreeWithOne) >> 3) + 1;
      for (let lo = lr + 1; lo + n - 1 <= 14; lo++) {
        const cards = [];
        const wings = [];
        let ok = true;
        for (let r = lo; r < lo + n; r++) {
          const cs = byRank.get(r);
          if (!cs || cs.length < 3) { ok = false; break; }
          cards.push(...cs.slice(0, 3));
        }
        if (!ok) continue;
        const trioSet = new Set();
        for (let r = lo; r < lo + n; r++) trioSet.add(r);
        for (const [r, cs] of byRank) {
          if (trioSet.has(r) || wings.length >= n) continue;
          if (cs.length < 4) { wings.push(cs[0]); }
        }
        if (wings.length >= n) out.push(cards.concat(wings.slice(0, n)));
      }
    } else if (lt >= ThreeWithPair + (1 << 3) && lt < FourWithOnes) {  // 飞机带对
      const n = ((lt - ThreeWithPair) >> 3) + 1;
      for (let lo = lr + 1; lo + n - 1 <= 14; lo++) {
        const cards = [];
        let ok = true;
        for (let r = lo; r < lo + n; r++) {
          const cs = byRank.get(r);
          if (!cs || cs.length < 3) { ok = false; break; }
          cards.push(...cs.slice(0, 3));
        }
        if (!ok) continue;
        const trioSet = new Set();
        for (let r = lo; r < lo + n; r++) trioSet.add(r);
        const wings = [];
        for (const [r, cs] of byRank) {
          if (trioSet.has(r) || wings.length >= 2 * n) continue;
          if (cs.length >= 2 && cs.length < 4) wings.push(...cs.slice(0, 2));
        }
        if (wings.length >= 2 * n) out.push(cards.concat(wings.slice(0, 2 * n)));
      }
    }
    // 炸弹/王炸兜底
    if (mode) {
      const j1 = hand.find(c => normId(c) === 53), j2 = hand.find(c => normId(c) === 54);
      if (j1 !== undefined && j2 !== undefined) out.push([j1, j2]);
    }
    if (lt !== Jokers) {
      for (const [r, cs] of byRank) if (cs.length === 4 && r < 15) out.push([...cs]);
    }
    // 过滤：全部再过一遍合法性 + 排序（rank 升序，炸弹在后）
    const valid = out.filter(cs => canBeat(mode, cs, lastCards));
    valid.sort((a, b) => {
      const [ta, ra] = parseCards(mode, a), [tb, rb] = parseCards(mode, b);
      if ((ta >= Four) !== (tb >= Four)) return ta >= Four ? 1 : -1;
      return ra - rb;
    });
    return valid;
  }

  /**
   * 跟牌决策
   * @param {object} opts {isLandlord, lastFromTeammate, oppMinCards, myCardsLeft}
   * @returns {number[]|null} 出的牌；null = 不出
   */
  function followPlay(hand, lastCards, mode, opts) {
    const o = opts || {};
    const cands = genFollows(hand, lastCards, mode);
    if (!cands.length) return null;
    const nonBomb = cands.filter(cs => parseCards(mode, cs)[0] < Four);
    // 队友出的大牌且局面不紧 → 不压（农民配合）
    if (o.lastFromTeammate && !o.isLandlord) {
      const [lt, lr] = parseCards(mode, lastCards);
      if (lr >= 14 && lt !== Bad) return null;                  // 队友 A 以上不压
      if (nonBomb.length && parseCards(mode, nonBomb[0])[1] >= 14) return null; // 要用大牌压队友 → 让
    }
    // 对手只剩 1-2 张：全力压，必要时拆牌/炸
    if (o.oppMinCards !== undefined && o.oppMinCards <= 2) {
      const best = nonBomb.length ? nonBomb[nonBomb.length - 1] : cands[0];
      return best || null;
    }
    // 常规：用最小的非炸牌压；没有才考虑炸（自己手数少或对手牌少）
    if (nonBomb.length) {
      // 别用大牌压小牌：若最小应手 ≥ A 且不紧迫，考虑 pass
      const c0 = nonBomb[0];
      const [t0, r0] = parseCards(mode, c0);
      const isBig = r0 >= 14;
      if (isBig && hand.length > 4 && !(o.lastFromOpponent === false)) {
        // 保守：大牌留后手，除非下家（对手）即将跑完——上面已处理
      }
      return c0;
    }
    // 只有炸弹可压：手数 ≤2 或对手 ≤3 张才炸
    const hc = handCount(hand, mode);
    if (hc <= 2 || (o.oppMinCards !== undefined && o.oppMinCards <= 3)) return cands[0];
    return null;
  }

  /** 领出决策：选手数最少拆解中最弱的组合 */
  function leadPlay(hand, mode, opts) {
    const o = opts || {};
    if (!hand.length) return null;
    const combos = decompose(hand, mode);
    // 对手只剩 1 张：出单张里最小的？不——出最大的单张防止被压，或出多张组合
    if (o.oppMinCards === 1) {
      const singles = combos.filter(c => c.type === One).sort((a, b) => b.rank - a.rank);
      const nonsingle = combos.filter(c => c.type !== One && c.type < Four).sort((a, b) => a.rank - b.rank);
      if (nonsingle.length) return nonsingle[0].cards;
      if (singles.length) return singles[0].cards;    // 最大单
    }
    if (o.oppMinCards === 2) {
      const pairs = combos.filter(c => c.type === Pair).sort((a, b) => b.rank - a.rank);
      if (pairs.length) return pairs[pairs.length - 1].cards;  // 最小对逼弹
    }
    // 常规：非炸组合里最小的（先出弱牌）
    const normal = combos
      .filter(c => c.type < Four)
      .sort((a, b) => (a.cards.length === b.cards.length ? a.rank - b.rank : b.cards.length - a.cards.length));
    if (normal.length) return normal[0].cards;
    // 只剩炸弹/王炸
    const bombs = combos.sort((a, b) => a.rank - b.rank);
    return bombs[0].cards;
  }

  /** 记牌器：整套牌里还没出现且不在我手里的牌（按 rank 统计）
   * @param {number[]} myHand 我的牌
   * @param {number[]} played 已出的牌（含底牌）
   * @param {number[]} holeCards 底牌（算已现）
   * @param {number} decks 副数（3人=1, 4人=2）
   */
  function remainingRanks(myHand, played, holeCards, decks) {
    const seen = new Map();
    for (const c of [...(played || []), ...(holeCards || []), ...(myHand || [])]) {
      const r = rankOf(c);
      seen.set(r, (seen.get(r) || 0) + 1);
    }
    const total = new Map();
    for (let id = 1; id <= 52; id++) total.set(RANK[id], (total.get(RANK[id]) || 0) + 1);
    total.set(53, decks);   // 小王
    total.set(54, decks);   // 大王
    const out = new Map();
    total.forEach((n, r) => {
      const left = n - (seen.get(r) || 0);
      if (left > 0) out.set(r, left);
    });
    return out;
  }

  const RANK_CN = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 53: '小王', 54: '大王' };
  const rankName = r => RANK_CN[r] || String(r);

  // ===== 状态解压（1:1 复刻模块 6139 的 g 函数）=====
  /**
   * @param {object} min {rule, state, landlordId, cardPositionList, playedCardList, v}
   * @param {number} playerCount
   * @returns 展开后的状态（含 playerCardLists/holeCardList/lastCards/canPlayAnyCards 等）
   */
  function expandState(min, playerCount) {
    const e = {
      rule: min.rule, state: min.state, landlordId: min.landlordId,
      cardPositionList: min.cardPositionList, playedCardList: min.playedCardList,
      v: min.v,
    };
    e.isFinish = e.state > 8;
    e.winner = e.isFinish ? 7 & e.state : 0;
    e.landlordWin = e.isFinish && e.winner === e.landlordId;
    e.holeCardList = e.cardPositionList.map((c, t) => 8 & c ? t + 1 : -1).filter(x => x >= 0);
    e.playerCardLists = [[]];
    e.playerRestCardCounts = [0];
    for (let t = 1; t <= playerCount; t++) {
      const list = e.cardPositionList.map((c, r) => (7 & c) === t ? r + 1 : -1).filter(x => x > -1);
      e.playerCardLists.push(list);
      e.playerRestCardCounts.push(e.winner === t ? 0 : list.length);
    }
    e.canPlayAnyCards = !e.playedCardList.length
      || new Array(playerCount - 1).fill(0).every((_, r) => e.playedCardList[e.playedCardList.length - 1 - r] === 0);
    e.lastCards = (function () {
      if (e.rule || e.canPlayAnyCards) return [];
      const t = [];
      for (let r = e.playedCardList.length - 1; r >= 0; r--) {
        const n = e.playedCardList[r];
        if (n) t.push(n);
        else if (t.length) break;
      }
      return t;
    })();
    return e;
  }

  return {
    RANK, normId, rankOf, cntMap, sortHand, rankName,
    Bad, One, Pair, Three, ThreeWithOne, ThreeWithPair, FourWithOnes, FourWithPairs, Four, Jokers,
    parseCards, canBeat, decompose, handCount,
    shouldBid, genFollows, followPlay, leadPlay, remainingRanks,
    expandState,
  };
});

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

HQ.mountStandalone();
})();
