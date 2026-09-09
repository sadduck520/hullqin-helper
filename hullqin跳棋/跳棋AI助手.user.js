// ==UserScript==
// @name         跳棋 AI 助手（game.hullqin.cn）
// @namespace    tq-ai-helper
// @version      1.0.0
// @description  桌游合集跳棋（中国跳棋）的 AI 助手：💡提示 + 🤖托管自动走子；negamax/贪心引擎，支持 2~6 人全部阵营布局与超级跳规则变体。朋友间娱乐使用。
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

HQ.mountStandalone();
})();
