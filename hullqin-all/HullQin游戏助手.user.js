// ==UserScript==
// @name         HullQin 游戏助手（整合版）
// @namespace    hq-ai-all-in-one
// @version      2.0.0
// @description  桌游合集全游戏 AI 助手整合版：🐘斗兽棋 ♞国际象棋 ⚫五子棋 🃏斗地主 🎯跳棋——按页面自动切换，一套面板。各自功能与独立版一致（提示/托管/记牌器/评估条等）。朋友间娱乐使用。
// @author       Eve
// @match        https://game.hullqin.cn/*
// @run-at       document-idle
// @grant        none
// @connect      cdn.jsdelivr.net
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
 * 斗兽棋引擎核心 —— 规则 1:1 逆向自 game.hullqin.cn 前端代码（模块 6390 的 sP/oe/qv）
 * 坐标：pos = row * 7 + col，row 0 为绿方底线（棋盘顶部），红方在 6-8 行
 * 棋子 id：0-7 红方（象狮虎豹狼狗猫鼠），8-15 绿方，id%8 = 类型
 * 类型编号越小越强：0象 1狮 2虎 3豹 4狼 5狗 6猫 7鼠（鼠吃象为特例）
 * 本文件不依赖 DOM，可在 Node 中测试、也可内嵌进油猴脚本
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DSQEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEAD = 63;          // 与游戏 OI.DEAD 一致：piecePos 中阵亡棋子的值
  const MAP_DEAD = -1;      // 棋盘空格
  const RED = 0, GREEN = 1;
  // 初始局面（游戏源码 LC()）
  const INIT_POS = [42, 62, 56, 46, 44, 54, 50, 48, 20, 0, 6, 16, 18, 8, 12, 14];
  const DENS = [59, 3];     // [红方兽穴(row8,col3), 绿方兽穴(row0,col3)]
  // 己方陷阱（红: (2,8)(4,8)(3,7)；绿: (2,0)(4,0)(3,1)）—— pos 值
  const TRAPS = [
    new Set([8 * 7 + 2, 8 * 7 + 4, 7 * 7 + 3]),
    new Set([0 * 7 + 2, 0 * 7 + 4, 1 * 7 + 3]),
  ];
  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // [dCol, dRow]
  const EMOJI = ['🐘', '🦁', '🐯', '🐆', '🐺', '🐶', '🐱', '🐭'];
  const NAMES = ['象', '狮', '虎', '豹', '狼', '狗', '猫', '鼠'];
  const VAL = [650, 520, 470, 350, 270, 230, 200, 190]; // 象狮虎豹狼狗猫鼠
  const WIN = 1000000;
  // ===== 进阶搜索增强 =====
  const QLIMIT = 16;            // 静态搜索（quiesce）最大吃子链长度（防死循环兜底）
  const TT_MAX = 300000;        // 置换表最大条目（超过清空，防止无限增长）
  const TT_MATE = WIN - 1000;   // 胜分归一化阈值
  const tt = new Map();         // 置换表：posKey -> {d:深度, v:归一化评估, f:0精确 1下界 2上界}
  function ttClear() { if (tt.size > TT_MAX) tt.clear(); }
  function ttStore(v, ply) { if (v >= TT_MATE) return v + ply; if (v <= -TT_MATE) return v - ply; return v; }
  function ttFetch(v, ply) { if (v >= TT_MATE) return v - ply; if (v <= -TT_MATE) return v + ply; return v; }

  // 走法评分（MVV-LVA）：吃大子优先、进兽穴绝对优先
  function moveScore(m, side) {
    const den = DENS[side === RED ? GREEN : RED];
    if (m.to === den) return 1000000; // 进兽穴即胜，绝对优先
    return m.victim >= 0 ? VAL[m.victim % 8] * 10 - VAL[m.pieceId % 8] / 10 : 0;
  }
  const isWater = (c, r) => ((c >= 1 && c <= 2) || (c >= 4 && c <= 5)) && r >= 3 && r <= 5;

  function boardFrom(pos) {
    const b = new Int8Array(63).fill(MAP_DEAD);
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD) b[p] = i;
    }
    return b;
  }

  // 大小吃子判定（逆向 y 函数）
  function canEat(attType, defType) {
    if (attType === 7 && defType === 0) return true;   // 鼠吃象
    if (attType === 0 && defType === 7) return false;  // 象不吃鼠
    return attType <= defType;                          // 编号小者强，同级可互吃
  }

  /**
   * 走子生成 —— 严格复刻游戏 sP(e,n)：
   * - 兽穴不可自入；仅鼠可入河；狮虎沿直线跳河（河中有任何棋子则被挡）
   * - 水中的鼠不能吃陆地上的非鼠棋子（可吃陆地/水中的鼠）
   * - 敌方棋子处于"我方陷阱"时，任意棋子可吃；空陷阱可自由进入
   * @param {Int8Array} board 63格棋盘（值为棋子id或-1）
   * @param {number} pieceId
   * @param {number} [knownPos] 已知棋子位置（跳过扫描）
   */
  function genMoves(board, pieceId, knownPos) {
    const res = [];
    const isRed = pieceId < 8;
    let pos = knownPos;
    if (pos === undefined || board[pos] !== pieceId) {
      pos = -1;
      for (let p = 0; p < 63; p++) if (board[p] === pieceId) { pos = p; break; }
    }
    if (pos === undefined || pos < 0) return res;
    const col = pos % 7, row = (pos / 7) | 0;
    const type = pieceId % 8;
    const ownDen = DENS[isRed ? RED : GREEN];
    const myTraps = TRAPS[isRed ? RED : GREEN];
    for (const [dc, dr] of DIRS) {
      let c = col + dc, r = row + dr;
      if (c < 0 || c > 6 || r < 0 || r > 8) continue;
      if (r * 7 + c === ownDen) continue;                    // 不可入己方兽穴
      if (isWater(c, r)) {
        if (type === 1 || type === 2) {                      // 狮/虎跳河
          let blocked = false;
          while (isWater(c, r)) {
            if (board[r * 7 + c] !== MAP_DEAD) { blocked = true; break; }
            c += dc; r += dr;
          }
          if (blocked || c < 0 || c > 6 || r < 0 || r > 8) continue;
        } else if (type !== 7) continue;                     // 只有鼠能下水
      }
      const target = board[r * 7 + c];
      if (target >= 0 && (target < 8) === isRed) continue;   // 己方棋子占据
      if (target >= 0) {
        if (type === 7 && isWater(col, row) && !isWater(c, r) && (target % 8) !== 7) continue; // 水鼠不吃陆上非鼠
        if (myTraps.has(r * 7 + c)) { res.push(r * 7 + c); continue; } // 敌子在我方陷阱：任意吃
        if (canEat(type, target % 8)) res.push(r * 7 + c);
      } else {
        res.push(r * 7 + c);
      }
    }
    return res;
  }

  /**
   * 某一方所有合法走法 [{pieceId, from, to, victim}]
   * @param {number[]} [pos16] 棋子位置数组（提供则免扫描，性能好很多）
   */
  function genAll(board, isRed, pos16) {
    const list = [];
    for (let i = isRed ? 0 : 8, end = isRed ? 8 : 16; i < end; i++) {
      const from = pos16 ? pos16[i] : undefined;
      if (pos16 && (!(from >= 0 && from < DEAD))) continue;
      const moves = genMoves(board, i, pos16 ? from : undefined);
      for (const to of moves) list.push({ pieceId: i, from: pos16 ? from : -1, to, victim: board[to] });
    }
    return list;
  }

  function applyMove(board, pos, alive, m) {
    const prev = { from: pos[m.pieceId], victim: board[m.to] };
    board[pos[m.pieceId]] = MAP_DEAD;
    board[m.to] = m.pieceId;
    pos[m.pieceId] = m.to;
    if (prev.victim >= 0) { pos[prev.victim] = DEAD; alive[prev.victim < 8 ? RED : GREEN]--; }
    return prev;
  }
  function undoMove(board, pos, alive, m, prev) {
    board[m.to] = prev.victim;
    board[prev.from] = m.pieceId;
    pos[m.pieceId] = prev.from;
    if (prev.victim >= 0) { pos[prev.victim] = m.to; alive[prev.victim < 8 ? RED : GREEN]++; }
  }

  // 评估（红方视角，正值利于红）
  function evaluate(board, pos) {
    let score = 0, redEle = false, greenEle = false;
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD && i % 8 === 0) { if (i < 8) redEle = true; else greenEle = true; }
    }
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (!(p >= 0 && p < DEAD)) continue;
      const side = i < 8 ? RED : GREEN;
      const type = i % 8, col = p % 7, row = (p / 7) | 0;
      let v = VAL[type];
      if (type === 7) v += (side === RED ? greenEle : redEle) ? 110 : -60; // 对面还有象时鼠更值钱
      const den = DENS[side === RED ? GREEN : RED];
      const dist = Math.abs(((den / 7) | 0) - row) + Math.abs((den % 7) - col);
      let adv = (12 - dist) * (type === 1 || type === 2 ? 5 : 4);
      if (dist <= 4) adv += (5 - dist) * 10;                 // 接近敌穴：额外冲穴奖励

      if (dist <= 2) adv += (3 - dist) * 150;                 // 兽穴门口的重压
      const enemyTraps = TRAPS[side === RED ? GREEN : RED];
      if (enemyTraps.has(p)) {                                 // 深陷敌陷阱：整体轻微减分
        v -= VAL[type] * 0.15;
        for (const [dc, dr] of DIRS) {                        // 旁有敌子 → 危（加重）
          const c = col + dc, r = row + dr;
          if (c < 0 || c > 6 || r < 0 || r > 8) continue;
          const q = board[r * 7 + c];
          if (q >= 0 && (q < 8) !== (side === RED)) { v -= VAL[type] * 0.55; break; }
        }
      }
      score += (side === RED ? 1 : -1) * (v + adv);
    }
    return score;
  }

  const posKey = (pos) => pos.join(',');

  /**
   * 搜索：negamax + α-β + 迭代加深 + 时间预算 + 重复局面规避
   * @param {Int8Array|number[]} piecePos16
   * @param {number} sideToMove 0红 1绿
   * @param {number} budgetMs
   * @param {string[]} [avoidKeys] 历史局面 key 列表（规避来回重复；同一 key 出现越多惩罚越重）
   * @param {object} [opts] {stalePly: 自上次吃子以来的半回合数（用于领先方紧迫感评估）}
   */
  function search(piecePos16, sideToMove, budgetMs, avoidKeys, opts) {
    const pos = Int8Array.from(piecePos16);
    const board = boardFrom(pos);
    const alive = [0, 0];
    for (let i = 0; i < 16; i++) {
      const p = pos[i];
      if (p >= 0 && p < DEAD) alive[i < 8 ? RED : GREEN]++;
    }
    const stalePly = opts && Number.isFinite(opts.stalePly) ? Math.max(0, opts.stalePly) : 0;
    // 深度控制：默认按时间预算（DSQ_FIXED_DEPTH=0）。设 DSQ_FIXED_DEPTH=N 则固定迭代到 N 层、不限制时间；
    // DSQ_MAX_DEPTH 可调时间模式下的最大深度（默认 14）。
    function numEnv(name) {
      if (typeof process !== 'undefined' && process.env) { const v = Number(process.env[name]); if (Number.isFinite(v)) return v; }
      if (typeof self !== 'undefined') { const v = Number(self[name]); if (Number.isFinite(v)) return v; }
      return 0;
    }
    const fixedDepth = numEnv('DSQ_FIXED_DEPTH') || 0;   // 浏览器可用 self.DSQ_FIXED_DEPTH 设置
    const maxDepthOpt = numEnv('DSQ_MAX_DEPTH') || 14;
    const maxDepth = fixedDepth > 0 ? Math.min(Math.max(2, fixedDepth), 30) : maxDepthOpt;
    const now0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deadline = fixedDepth > 0 ? Infinity : now0 + budgetMs;
    let nodes = 0, aborted = false;
    // 历史重复统计：key -> 已出现次数（供根节点按次数递增惩罚）
    const repCount = new Map();
    if (avoidKeys && avoidKeys.length) for (const k of avoidKeys) repCount.set(k, (repCount.get(k) || 0) + 1);

    function timeUp() {
      if ((++nodes & 511) !== 0) return false;
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) > deadline) { aborted = true; return true; }
      return false;
    }

    // 叶子评估（行棋方视角）：无吃子回合增多时，领先方被逐步压分 → 领先方必须主动求变，
    // 从根源上消解「双方来回摇摆」的死局；落后方则相对受益（可接受重复求和）。
    function standPat(side) {
      let ev = evaluate(board, pos);
      if (stalePly >= 10) {
        const urg = Math.min((stalePly - 10) * 3, 90);
        if (ev > 60) ev -= urg;
        else if (ev < -60) ev += urg;
      }
      return (side === RED ? 1 : -1) * ev;
    }

    // 静态搜索（quiescence）：只搜吃子与进兽穴的“交换链”，消除水平线效应（弃子连续反吃看得清）
    function quiesce(alpha, beta, side, ply) {
      if (timeUp()) return 0;
      const stand = standPat(side);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      const moves = genAll(board, side === RED, pos);
      if (moves.length === 0) return -(WIN - ply);          // 无棋可走 = 输
      const den = DENS[side === RED ? GREEN : RED];
      const tactical = [];
      for (const m of moves) if (m.victim >= 0 || m.to === den) tactical.push(m);
      if (tactical.length === 0) return stand;              // 无吃无冲穴：静态值已够稳
      for (const m of tactical) m._s = moveScore(m, side);
      tactical.sort((a, b) => b._s - a._s);
      let best = stand, n = 0;
      for (const m of tactical) {
        if (++n > QLIMIT) break;
        const prev = applyMove(board, pos, alive, m);
        let score;
        if (m.to === den || alive[side === RED ? GREEN : RED] === 0) score = WIN - ply - 1;
        else score = -quiesce(-beta, -alpha, side === RED ? GREEN : RED, ply + 1);
        undoMove(board, pos, alive, m, prev);
        if (aborted) return best;
        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    // 搜索路径上的局面集合：树内再遇到即视为重复（轻微负分，消除「来回走不亏」的幻觉）
    const pathSet = new Set([pos.join(',')]);
    const REP_PATH_SCORE = -24;

    function negamax(depth, alpha, beta, side, ply) {
      if (timeUp()) return 0;
      const pk = pos.join(',');
      if (pathSet.has(pk)) return REP_PATH_SCORE;           // 树内重复：来回走无意义
      // 置换表：深度 ≥2 才查（浅层表开销不值）
      const ttKey = depth >= 2 ? pk + '|' + side : null;    // 置换表键含行棋方，避免红/绿回合串用
      let ttE = null;
      if (ttKey !== null) { ttE = tt.get(ttKey); ttClear(); }
      if (ttE && ttE.d >= depth) {
        const tv = ttFetch(ttE.v, ply);
        if (ttE.f === 0) return tv;
        if (ttE.f === 1 && tv > alpha) alpha = tv;
        if (ttE.f === 2 && tv < beta) beta = tv;
        if (alpha >= beta) return tv;
      }
      const alphaOrig = alpha;
      const moves = genAll(board, side === RED, pos);
      if (moves.length === 0) return -(WIN - ply);            // 无棋可走 = 输
      if (moves.length > 1) {
        for (const m of moves) m._s = moveScore(m, side);
        moves.sort((a, b) => b._s - a._s);
      }
      pathSet.add(pk);
      let best = -Infinity;
      for (const m of moves) {
        const prev = applyMove(board, pos, alive, m);
        let score;
        if (m.to === DENS[side === RED ? GREEN : RED] || alive[side === RED ? GREEN : RED] === 0) {
          score = WIN - ply - 1;                               // 进兽穴 / 全歼
        } else if (depth <= 1) {
          score = -quiesce(-beta, -alpha, side === RED ? GREEN : RED, ply + 1); // 深度用尽：静态搜索续算对手回合同步交换链
        } else {
          score = -negamax(depth - 1, -beta, -alpha, side === RED ? GREEN : RED, ply + 1);
        }
        undoMove(board, pos, alive, m, prev);
        if (aborted) return 0;
        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      pathSet.delete(pk);
      if (ttKey !== null && !aborted) {
        const flag = best <= alphaOrig ? 2 : best >= beta ? 1 : 0;
        tt.set(ttKey, { d: depth, v: ttStore(best, ply), f: flag });
      }
      return best;
    }

    // 迷你开局书：DSQ_BOOK=1 且红方首步时直接走 狮62->55
    // （400 局自对弈数据：引擎开局收敛为 狮62->55 / 豹46->45，前者红胜率 60.8% 更高；
    //   浏览器插件默认开，Node 测试默认关，可设环境变量 DSQ_BOOK=1 开启）
    if (numEnv('DSQ_BOOK') === 1 && sideToMove === RED && posKey(piecePos16) === INIT_POS.join(',')) {
      return { move: { pieceId: 1, from: 62, to: 55, victim: -1 }, score: 0, depth: 0, nodes: 0, ms: 0 };
    }
    const rootMoves = genAll(board, sideToMove === RED, pos);
    if (rootMoves.length === 0) return { move: null, score: -WIN, depth: 0, nodes: 0, ms: 0 };
    for (const m of rootMoves) m._s = moveScore(m, sideToMove);
    rootMoves.sort((a, b) => b._s - a._s);

    // 根节点走法会导致的重复局面 → 按历史出现次数排序沉底 + 终选动态降分
    if (repCount.size) {
      for (const m of rootMoves) {
        const savedFrom = pos[m.pieceId];
        const victim = board[m.to];
        const victimPos = victim >= 0 ? pos[victim] : -1;
        board[savedFrom] = MAP_DEAD; board[m.to] = m.pieceId; pos[m.pieceId] = m.to;
        if (victim >= 0) pos[victim] = DEAD;
        m._repCount = repCount.get(posKey(pos)) || 0;
        board[savedFrom] = m.pieceId; board[m.to] = victim; pos[m.pieceId] = savedFrom;
        if (victim >= 0) pos[victim] = victimPos;
      }
      rootMoves.sort((a, b) => (a._repCount || 0) - (b._repCount || 0));
    }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let bestMove = rootMoves[0], bestScore = 0, finishedDepth = 0;
    const rootPk = pos.join(',');
    for (let depth = 2; depth <= maxDepth; depth++) {
      let iterBest = null, iterScore = -Infinity;
      let alpha = -Infinity;
      const ordered = [bestMove, ...rootMoves.filter(m => m !== bestMove)];
      // 上一轮迭代若曾超时中止，negamax 提前 return 会残留路径集合 → 每轮迭代重置
      pathSet.clear();
      pathSet.add(rootPk);
      for (const m of ordered) {
        const prev = applyMove(board, pos, alive, m);
        let score;
        if (m.to === DENS[sideToMove === RED ? GREEN : RED] || alive[sideToMove === RED ? GREEN : RED] === 0) {
          score = WIN - 1;
        } else {
          score = -negamax(depth - 1, -Infinity, -alpha, sideToMove === RED ? GREEN : RED, 1);
        }
        undoMove(board, pos, alive, m, prev);
        if (aborted) break;
        // 重复局面动态降分（score 为行棋方视角）：
        //   随历史出现次数递增；我方明显占优时加倍（领先方必须求变）；明显劣势时减轻（允许重复求和）
        if (m._repCount) {
          let pen = 200 + 500 * (m._repCount - 1);
          if (score > 200) pen *= 2;
          else if (score < -200) pen = 40;
          score -= pen;
        }
        if (score > iterScore) { iterScore = score; iterBest = m; }
        if (score > alpha) alpha = score;
      }
      if (aborted) break;
      bestMove = iterBest; bestScore = iterScore; finishedDepth = depth;
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return {
      move: { pieceId: bestMove.pieceId, from: bestMove.from, to: bestMove.to, victim: bestMove.victim },
      score: bestScore, depth: finishedDepth, nodes, ms: Math.round(ms),
    };
  }

  return {
    DEAD, MAP_DEAD, RED, GREEN, INIT_POS, DENS, TRAPS, DIRS, EMOJI, NAMES, VAL, WIN,
    isWater, boardFrom, canEat, genMoves, genAll, applyMove, undoMove, evaluate, search, posKey,
  };
});






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

/**
 * 五子棋引擎核心 —— 15 路棋盘，negamax + αβ + 迭代加深 + 置换表 + 强制应手
 *
 * 坐标：pos = row * 15 + col，row 0 为棋盘顶部（y=-70）；页面 x/y ∈ {-70..70} 步长 10
 * 棋谱：站点本地模式把每手编码进 URL 参数 p，每 2 字符一手「列行」（如天元 = "77"）
 *
 * 规则（与页面 rule 枚举对应，0~7）：
 *   0 无禁手      长连也算胜
 *   1 有禁手      黑方三三/四四/长连禁手，恰好五连胜
 *   2 一手交换    按无禁手处理（长连算胜；交换抉择由用户手动完成）
 *   3 RIF / 4 山口 / 5 索索夫8 / 6 塔拉山口10   均为有禁手连珠规则
 *   7 Swap2长连不胜  无禁手，但长连不算胜
 *   开局规则的交换/打点等特殊抉择不在引擎内处理（v1 提示用户手动完成）。
 *
 * 本文件不依赖 DOM，可在 Node 中测试、也可内嵌进油猴脚本。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WZQEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
    const N = 15, SIZE = 225;
    const EMPTY = 0, BLACK = 1, WHITE = 2;
    // [dx, dy] 四个方向
    const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const WIN = 10000000;

    // ----- 规则工具 -----
    const isForbiddenRule = rule => rule === 1 || rule === 3 || rule === 4 || rule === 5 || rule === 6;
    const overlineWins = rule => rule === 0 || rule === 2;   // rule 7 长连不胜；禁手规则恰好五连胜

    // ----- 坐标 / 棋谱 -----
    const xyToPos = (x, y) => (Math.round(y / 10) + 7) * N + (Math.round(x / 10) + 7);
    const posToXY = pos => ({ x: (pos % N - 7) * 10, y: ((pos / N | 0) - 7) * 10 });
    // 联机棋盘坐标转置：源码渲染 pos=15*E+e 时 x=10*E-70（x=行）、y=10*e-70（y=列），与本地相反
    const xyToPosT = (x, y) => (Math.round(x / 10) + 7) * N + (Math.round(y / 10) + 7);
    const posToXYT = pos => ({ x: ((pos / N | 0) - 7) * 10, y: (pos % N - 7) * 10 });
    const posName = pos => `(${(pos % N) + 1},${(pos / N | 0) + 1})`;
    /** 解析 URL 棋谱 p（每 2 字符一手「列行」，15 进制：0-9a-e）→ {moves:[pos...], board} */
    function fromP(p) {
      const board = new Int8Array(SIZE);
      const moves = [];
      if (typeof p === 'string') {
        for (let i = 0; i + 1 < p.length; i += 2) {
          const col = parseInt(p[i], 15), row = parseInt(p[i + 1], 15);
          if (!(col >= 0 && col < N && row >= 0 && row < N)) break;
          const pos = row * N + col;
          if (board[pos] !== EMPTY) break;              // 非法棋谱，截断
          board[pos] = (moves.length % 2 === 0) ? BLACK : WHITE;
          moves.push(pos);
        }
      }
      return { board, moves };
    }
    const toP = moves => moves.map(pos => (pos % N).toString(15) + (pos / N | 0).toString(15)).join('');

    // ----- 直线表（评估用）-----
    const LINES = [];      // [{cells:[pos...]}]
    const posLines = [];   // pos -> [[lineIdx, cellIdx] × 4]
    for (let i = 0; i < SIZE; i++) posLines[i] = [];
    function addLine(cells) {
      if (cells.length < 5) return;
      const idx = LINES.length;
      LINES.push(cells);
      cells.forEach((pos, j) => posLines[pos].push([idx, j]));
    }
    for (let r = 0; r < N; r++) addLine(Array.from({ length: N }, (_, c) => r * N + c));
    for (let c = 0; c < N; c++) addLine(Array.from({ length: N }, (_, r) => r * N + c));
    for (let s = 0; s <= 2 * (N - 1); s++) {   // ↘ 对角线：row-col = s - (N-1) → 用 r+c 枚举反向
      const cells = [];
      for (let r = 0; r < N; r++) { const c = s - r; if (c >= 0 && c < N) cells.push(r * N + c); }
      addLine(cells);
    }
    for (let s = -(N - 1); s <= N - 1; s++) {  // ↗ 对角线：row+col = s? → c = r - s? 用 r-c=s
      const cells = [];
      for (let r = 0; r < N; r++) { const c = r - s; if (c >= 0 && c < N) cells.push(r * N + c); }
      addLine(cells);
    }
    const LINE_COUNT = LINES.length;

    // ----- 局面评估：逐线棋型打分 + 增量更新 -----
    const W_FIVE = 10000000, W_LIVE4 = 100000, W_RUSH4 = 12000, W_LIVE3 = 8000,
      W_SLEEP3 = 600, W_LIVE2 = 300, W_SLEEP2 = 40;

    // 单线单方分数：分析「连子段 + 单格断点合并」的棋型
    function lineScoreFor(board, cells, me) {
      let total = 0;
      // 先把这条线的棋盘值取出来（cells 是位置数组）
      const n = cells.length;
      const vals = lineValsBuf.length >= n ? lineValsBuf : (lineValsBuf = new Array(n));
      for (let t = 0; t < n; t++) vals[t] = board[cells[t]];
      const isMe = v => v === me, isEmpty = v => v === EMPTY;
      let i = 0;
      while (i < n) {
        if (!isMe(vals[i])) { i++; continue; }
        let j = i;
        while (j + 1 < n && isMe(vals[j + 1])) j++;
        const len = j - i + 1;
        const left = i > 0 ? vals[i - 1] : 3;      // 3 = 边界墙
        const right = j + 1 < n ? vals[j + 1] : 3;
        const left2 = i > 1 ? vals[i - 2] : 3;
        const right2 = j + 2 < n ? vals[j + 2] : 3;
        if (len >= 5) { total += W_FIVE; }
        else if (len === 4) {
          const le = isEmpty(left), re = isEmpty(right);
          if (le && re) total += W_LIVE4;
          else if (le || re) total += W_RUSH4;
        } else if (len === 3) {
          const le = isEmpty(left), re = isEmpty(right);
          if (le && re && (isEmpty(left2) || isEmpty(right2))) total += W_LIVE3;
          else if (le || re) total += W_SLEEP3;
        } else if (len === 2) {
          const le = isEmpty(left), re = isEmpty(right);
          if (le && re && (isEmpty(left2) || isEmpty(right2))) total += W_LIVE2;
          else if (le || re) total += W_SLEEP2;
        } else if (len === 1) {
          if (isEmpty(left) && isEmpty(right)) total += 10;
        }
        // 单格断点合并：run + 1空 + run2
        if (len <= 4 && isEmpty(right) && j + 2 < n && isMe(vals[j + 2])) {
          let k = j + 2;
          while (k + 1 < n && isMe(vals[k + 1])) k++;
          const len2 = k - (j + 2) + 1;
          const comb = len + len2;
          const far = k + 1 < n ? vals[k + 1] : 3;
          const far2 = k + 2 < n ? vals[k + 2] : 3;
          if (comb >= 5) total += W_FIVE / 2;                    // 断点五（补空即五）
          else if (comb === 4) {
            if (isEmpty(left) && isEmpty(far)) total += W_RUSH4 + W_LIVE3 / 2;  // 断点四，两头空=极强
            else total += W_RUSH4;
          } else if (comb === 3) {
            if (isEmpty(left) && isEmpty(far) && (isEmpty(left2) || isEmpty(far2))) total += W_LIVE3;
            else total += W_SLEEP3;
          } else if (comb === 2 && isEmpty(left) && isEmpty(far)) total += W_LIVE2;
          i = k + 1;
        } else {
          i = j + 1;
        }
      }
      return total;
    }

    // lineScores[lineIdx*2 + (0=黑,1=白)]
    let lineValsBuf = new Array(15);
    // 局部重算某条线
    function lineScoresAt(board, l, out) {
      const cells = LINES[l];
      out[0] = lineScoreFor(board, cells, BLACK);
      out[1] = lineScoreFor(board, cells, WHITE);
    }

    // ----- 走子（增量评估 + Zobrist）-----
    function mulberry32(a) {
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    const rnd = mulberry32(0x5F3759DF);
    const ZOB = [new Uint32Array(SIZE), new Uint32Array(SIZE)];
    for (let p = 0; p < SIZE; p++) { ZOB[0][p] = (rnd() * 4294967296) >>> 0; ZOB[1][p] = (rnd() * 4294967296) >>> 0; }

    function makeState(board) {
      const ls = new Float64Array(LINE_COUNT * 2);
      for (let l = 0; l < LINE_COUNT; l++) {
        const cells = LINES[l];
        ls[l * 2] = lineScoreFor(board, cells, BLACK);
        ls[l * 2 + 1] = lineScoreFor(board, cells, WHITE);
      }
      let h1 = 0, h2 = 0;
      for (let p = 0; p < SIZE; p++) {
        if (board[p] === BLACK) { h1 ^= ZOB[0][p]; h2 ^= ZOB[1][p]; }
        else if (board[p] === WHITE) { h1 ^= ZOB[0][p] * 3; h2 ^= ZOB[1][p] * 7; }
      }
      return { board, ls, h1, h2 };
    }

    const tmpLS = new Float64Array(2);
    function place(st, pos, color) {
      const b = st.board;
      b[pos] = color;
      if (color === BLACK) { st.h1 ^= ZOB[0][pos]; st.h2 ^= ZOB[1][pos]; }
      else { st.h1 ^= ZOB[0][pos] * 3; st.h2 ^= ZOB[1][pos] * 7; }
      for (const [l] of posLines[pos]) {
        const old = l * 2;
        lineScoresAt(b, l, tmpLS);
        st.ls[old] = tmpLS[0]; st.ls[old + 1] = tmpLS[1];
      }
    }
    function unplace(st, pos, color) {
      const b = st.board;
      b[pos] = EMPTY;
      if (color === BLACK) { st.h1 ^= ZOB[0][pos]; st.h2 ^= ZOB[1][pos]; }
      else { st.h1 ^= ZOB[0][pos] * 3; st.h2 ^= ZOB[1][pos] * 7; }
      for (const [l] of posLines[pos]) {
        lineScoresAt(b, l, tmpLS);
        st.ls[l * 2] = tmpLS[0]; st.ls[l * 2 + 1] = tmpLS[1];
      }
    }

    // ----- 胜负 / 禁手判定 -----
    /** pos 处棋子所在方向的最大连长 */
    function runLenAt(board, pos) {
      const color = board[pos];
      if (!color) return 0;
      const r = pos / N | 0, c = pos % N;
      let best = 1;
      for (const [dc, dr] of DIRS) {
        let len = 1;
        for (let k = 1; k < 6; k++) { const cc = c + dc * k, rr = r + dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N || board[rr * N + cc] !== color) break; len++; }
        for (let k = 1; k < 6; k++) { const cc = c - dc * k, rr = r - dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N || board[rr * N + cc] !== color) break; len++; }
        if (len > best) best = len;
      }
      return best;
    }
    /**
     * 刚在 pos 落下棋子后的胜负态（board[pos] 需已落子）
     * 'win' 胜；'overline' 长连未胜（rule7 双方长连皆不算胜、仅继续；
     *   禁手规则下黑长连属禁手，正常流程会被走法过滤掉）
     */
    function checkWinAt(board, pos, rule) {
      const len = runLenAt(board, pos);
      if (len === 5) return 'win';
      if (len > 5) {
        if (overlineWins(rule)) return 'win';
        if (isForbiddenRule(rule) && board[pos] === WHITE) return 'win';   // 连珠规则白方长连也算胜
        return 'overline';
      }
      return null;
    }

    /** 取以 pos 为中心、某方向 ±5 的窗口（含边界墙 3） */
    function windowAt(board, pos, di) {
      const [dc, dr] = DIRS[di];
      const r = pos / N | 0, c = pos % N;
      const w = new Array(11);
      for (let k = -5; k <= 5; k++) {
        const cc = c + dc * k, rr = r + dr * k;
        w[k + 5] = (cc < 0 || cc >= N || rr < 0 || rr >= N) ? 3 : board[rr * N + cc];
      }
      return w;   // 中心 = w[5]
    }

    /**
     * 分析：假设 pos 落 BLACK 后，穿过 pos 的棋型（禁手判定用）
     * @returns {five, overline, fours, liveThrees}  four/liveThree 均为穿过 pos 的计数
     */
    function analyzeBlackPoint(board, pos) {
      const b = board; let five = false, overline = false, fours = 0, liveThrees = 0;
      // 虚拟落子（调用方保证 pos 为空）
      b[pos] = BLACK;
      for (let di = 0; di < 4; di++) {
        const w = windowAt(b, pos, di);
        // 中心连长
        let s = 5, e = 5;
        while (s > 0 && w[s - 1] === BLACK) s--;
        while (e < 10 && w[e + 1] === BLACK) e++;
        const len = e - s + 1;
        if (len === 5) five = true;
        if (len >= 6) overline = true;
        // 若已是活四 → 本方向记 1 个四；否则数不同补点成「恰好五连」的数量（冲四）
        // 注意：补点后长连（>5）不算四——对黑方那是禁手点
        if (len === 4 && w[s - 1] === EMPTY && w[e + 1] === EMPTY) {
          fours += 1;
        } else {
          let rush = 0;
          for (let k = 0; k < 11; k++) {
            if (w[k] !== EMPTY) continue;
            w[k] = BLACK;
            let s2 = 5, e2 = 5;
            while (s2 > 0 && w[s2 - 1] === BLACK) s2--;
            while (e2 < 10 && w[e2 + 1] === BLACK) e2++;
            if (e2 - s2 + 1 === 5 && s2 <= 5 && e2 >= 5) rush++;
            w[k] = EMPTY;
          }
          fours += rush;
        }
        // 活三：存在某空点，落子后成活四（每方向最多记 1）
        let live3 = false;
        for (let k = 0; k < 11 && !live3; k++) {
          if (w[k] !== EMPTY) continue;
          w[k] = BLACK;
          let s2 = 5, e2 = 5;
          while (s2 > 0 && w[s2 - 1] === BLACK) s2--;
          while (e2 < 10 && w[e2 + 1] === BLACK) e2++;
          if (e2 - s2 + 1 === 4 && w[s2 - 1] === EMPTY && w[e2 + 1] === EMPTY) live3 = true;
          w[k] = EMPTY;
        }
        if (live3) liveThrees++;
      }
      b[pos] = EMPTY;
      return { five, overline, fours, liveThrees };
    }

    /** 黑方 pos 是否禁手（仅禁手规则下调用；pos 必须为空） */
    function isForbiddenPoint(board, pos) {
      const a = analyzeBlackPoint(board, pos);
      if (a.five) return false;           // 成五优先，不算禁手
      if (a.overline) return true;        // 长连禁手
      if (a.fours >= 2) return true;      // 四四
      if (a.liveThrees >= 2) return true; // 三三
      return false;
    }

    // ----- 走法生成（含强制应手）-----

    /** 已有棋子切比雪夫距离 2 内的空点集合（成五点必然在其中：五连必有邻子） */
    function neighborhood(board) {
      const set = new Set();
      for (let p = 0; p < SIZE; p++) {
        if (board[p] === EMPTY) continue;
        const r = p / N | 0, c = p % N;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
            const q = rr * N + cc;
            if (board[q] === EMPTY) set.add(q);
          }
        }
      }
      return set;
    }

    /** pos 附近的快速点评分（走法排序用）：己方进攻 + 对方防守 */
    function pointScore(board, pos, me, opp) {
      const r0 = pos / N | 0, c0 = pos % N;
      let sc = 0;
      for (const [dc, dr] of DIRS) {
        for (const who of [me, opp]) {
          let len = 1, openL = 0, openR = 0;
          let k = 1;
          while (true) { const cc = c0 + dc * k, rr = r0 + dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N) break; const v = board[rr * N + cc]; if (v === who) { len++; k++; continue; } if (v === EMPTY) openL = 1; break; }
          k = 1;
          while (true) { const cc = c0 - dc * k, rr = r0 - dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N) break; const v = board[rr * N + cc]; if (v === who) { len++; k++; continue; } if (v === EMPTY) openR = 1; break; }
          let s = 0;
          if (len >= 5) s = 1e6;
          else if (len === 4) s = openL && openR ? 1e5 : (openL || openR ? 1.2e4 : 0);
          else if (len === 3) s = openL && openR ? 8e3 : (openL || openR ? 600 : 0);
          else if (len === 2) s = openL && openR ? 300 : (openL || openR ? 40 : 0);
          else s = openL && openR ? 10 : 0;
          sc += who === me ? s : s * 0.9;
        }
      }
      return sc;
    }

    /** 某方所有「再落一子即成五连」的点（只扫邻域空点） */
    function fivePoints(board, color, cand) {
      const res = [];
      for (const p of cand) {
        const r0 = p / N | 0, c0 = p % N;
        for (const [dc, dr] of DIRS) {
          let len = 1;
          for (let k = 1; k <= 4; k++) { const cc = c0 + dc * k, rr = r0 + dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N || board[rr * N + cc] !== color) break; len++; }
          for (let k = 1; k <= 4; k++) { const cc = c0 - dc * k, rr = r0 - dr * k; if (cc < 0 || cc >= N || rr < 0 || rr >= N || board[rr * N + cc] !== color) break; len++; }
          if (len >= 5) { res.push(p); break; }
        }
      }
      return res;
    }

    /**
     * 生成候选走法（带强制应手与禁手过滤）
     * @returns {number[]} 候选 pos 列表（已按分排序，最多 cap 个）
     */
    function genCandidates(board, color, rule, cap) {
      const opp = color === BLACK ? WHITE : BLACK;
      const cand = neighborhood(board);
      if (!cand.size) return [7 * N + 7];       // 空棋盘 → 天元
      const myFive = fivePoints(board, color, cand);
      if (myFive.length) {
        // 成五即胜；禁手规则下黑方的长连成五点要剔除
        if (color === BLACK && isForbiddenRule(rule)) {
          const legal = myFive.filter(p => !isForbiddenPoint(board, p));
          if (legal.length) return legal;
          // 成五点全被禁手否掉 → 退回一般候选
        } else return myFive;
      }
      const oppFive = fivePoints(board, opp, cand);
      if (oppFive.length) {
        // 对方下一步成五：只能堵（黑方还需过禁手检查）
        let blocks = oppFive;
        if (color === BLACK && isForbiddenRule(rule)) {
          blocks = blocks.filter(p => !isForbiddenPoint(board, p));
          if (!blocks.length) return [];        // 堵点全禁 → 黑方已败
        }
        return blocks;
      }
      const forbid = color === BLACK && isForbiddenRule(rule);
      const scored = [];
      for (const p of cand) {
        if (forbid && isForbiddenPoint(board, p)) continue;
        scored.push([pointScore(board, p, color, opp), p]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      const out = [];
      for (let i = 0; i < scored.length && i < cap; i++) out.push(scored[i][1]);
      return out;
    }

    /**
     * 败走：无制胜/防守走法（如被禁手杀）时，返回一个「至少合法」的落点，
     * 让对局能继续走到终局（页面不会代判负）。返回 -1 表示连合法点都没有（满盘/全禁）。
     */
    function desperateMove(board, color, rule) {
      const cand = neighborhood(board);
      const forbid = color === BLACK && isForbiddenRule(rule);
      let best = -1, bestSc = -1;
      for (const p of cand) {
        if (forbid && isForbiddenPoint(board, p)) continue;
        const sc = pointScore(board, p, color, color === BLACK ? WHITE : BLACK);
        if (sc > bestSc) { bestSc = sc; best = p; }
      }
      return best;
    }

    // ----- 评估 -----
    function evaluate(st, me) {
      const ls = st.ls;
      let sc = 0;
      for (let l = 0; l < LINE_COUNT; l++) {
        if (me === BLACK) sc += ls[l * 2] - ls[l * 2 + 1];
        else sc += ls[l * 2 + 1] - ls[l * 2];
      }
      return sc;
    }

    // ----- 置换表 -----
    const TT_MAX = 200000;
    const tt = new Map();
    function ttKey(st) { return st.h1 + '_' + st.h2; }

    // ----- 搜索 -----
    let nodeCount = 0, deadline = 0, aborted = false;

    function quiesce(st, color, rule, alpha, beta, ply, qdepth) {
      nodeCount++;
      const cand = neighborhood(st.board);
      // 己方成五点 → 直接赢
      const myFive = fivePoints(st.board, color, cand);
      if (myFive.length) {
        if (color === BLACK && isForbiddenRule(rule)) {
          const legal = myFive.filter(p => !isForbiddenPoint(st.board, p));
          if (legal.length) return WIN - ply;
        } else return WIN - ply;
      }
      const opp = color === BLACK ? WHITE : BLACK;
      const oppFive = fivePoints(st.board, opp, cand);
      if (oppFive.length) {
        if (qdepth <= 0) return -WIN + ply + 1;   // 对方成五在即且不再延伸 → 视作败
        let best = -WIN * 2;
        let blocks = oppFive;
        if (color === BLACK && isForbiddenRule(rule)) blocks = blocks.filter(p => !isForbiddenPoint(st.board, p));
        if (!blocks.length) return -WIN + ply + 1;
        for (const p of blocks) {
          place(st, p, color);
          const v = -quiesce(st, opp, rule, -beta, -alpha, ply + 1, qdepth - 1);
          unplace(st, p, color);
          if (v > best) best = v;
          if (best > alpha) alpha = best;
          if (alpha >= beta) break;
        }
        return best;
      }
      return evaluate(st, color);
    }

    function negamax(st, color, rule, depth, alpha, beta, ply) {
      if ((nodeCount & 1023) === 0 && Date.now() > deadline) { aborted = true; return 0; }
      nodeCount++;
      if (depth <= 0) return quiesce(st, color, rule, alpha, beta, ply, 4);
      const key = ttKey(st);
      const hit = tt.get(key);
      let ttBest = -1;
      if (hit && hit.d >= depth) {
        const v = hit.v > WIN - 1000 ? hit.v - ply : hit.v < -(WIN - 1000) ? hit.v + ply : hit.v;
        if (hit.f === 0) return v;
        if (hit.f === 1 && v > alpha) alpha = v;
        else if (hit.f === 2 && v < beta) beta = v;
        if (alpha >= beta) return v;
      }
      if (hit) ttBest = hit.m;
      const opp = color === BLACK ? WHITE : BLACK;
      const moves = genCandidates(st.board, color, rule, depth >= 4 ? 20 : 14);
      if (!moves.length) return -WIN + ply + 1;   // 无棋可走（禁手封死）
      if (ttBest >= 0) {
        const ix = moves.indexOf(ttBest);
        if (ix > 0) { moves.splice(ix, 1); moves.unshift(ttBest); }
      }
      let best = -WIN * 2, bestMove = -1, f = 2;
      for (const p of moves) {
        place(st, p, color);
        let v;
        const wl = runLenAt(st.board, p);
        if (wl === 5 || (wl > 5 && (overlineWins(rule) || (isForbiddenRule(rule) && color === WHITE)))) v = WIN - ply - 1;
        else v = -negamax(st, opp, rule, depth - 1, -beta, -alpha, ply + 1);
        unplace(st, p, color);
        if (aborted) return 0;
        if (v > best) { best = v; bestMove = p; }
        if (best > alpha) { alpha = best; f = 0; }
        if (alpha >= beta) { f = 1; break; }
      }
      const vv = best > WIN - 1000 ? best + ply : best < -(WIN - 1000) ? best - ply : best;
      if (tt.size > TT_MAX) tt.clear();
      tt.set(key, { d: depth, v: vv, f, m: bestMove });
      return best;
    }

    /**
     * 搜索入口
     * @param {Int8Array} board 225 格棋盘
     * @param {number} color BLACK/WHITE（当前行棋方）
     * @param {object} opts {timeMs=600, maxDepth=12, rule=0}
     * @returns {{move, score, depth, nodes, root:[{pos,sc}]}}
     */
    function search(board, color, opts) {
      const o = opts || {};
      const rule = o.rule === undefined ? 0 : o.rule;
      const timeMs = o.timeMs || 600;
      const maxDepth = Math.min(o.maxDepth || 12, 20);
      const st = makeState(board);
      tt.clear();
      nodeCount = 0; aborted = false;
      deadline = Date.now() + timeMs;
      let bestResult = null;
      let rootMoves = genCandidates(st.board, color, rule, 24);
      if (!rootMoves.length) return { move: -1, score: 0, depth: 0, nodes: 0, root: [] };
      if (rootMoves.length === 1) return { move: rootMoves[0], score: 0, depth: 1, nodes: 0, root: rootMoves.map(p => ({ pos: p, sc: 0 })) };
      let lastRoot = [];
      for (let d = 2; d <= maxDepth; d++) {
        const opp = color === BLACK ? WHITE : BLACK;
        let alpha = -WIN * 2, best = -WIN * 2, bestMove = -1;
        const root = [];
        let completed = true;
        for (const p of rootMoves) {
          place(st, p, color);
          let v;
          const wl = runLenAt(st.board, p);
          if (wl === 5 || (wl > 5 && (overlineWins(rule) || (isForbiddenRule(rule) && color === WHITE)))) v = WIN - 1;
          else v = -negamax(st, opp, rule, d - 1, -WIN * 2, -alpha, 1);
          unplace(st, p, color);
          if (aborted) { completed = false; break; }
          root.push({ pos: p, sc: v });
          if (v > best) { best = v; bestMove = p; alpha = v; }
        }
        if (completed && bestMove >= 0) {
          root.sort((a, b) => b.sc - a.sc);
          lastRoot = root;
          rootMoves = root.map(x => x.pos);       // 下一轮按本轮得分重排（更好的剪枝）
          bestResult = { move: bestMove, score: best, depth: d, nodes: nodeCount, root: root.slice(0, 8) };
          if (best > WIN - 1000) break;   // 已找到必胜
          if (best < -(WIN - 1000)) break; // 已是必败，不再加深
        }
        if (aborted || Date.now() > deadline) break;
      }
      if (!bestResult) {
        // 时间极短：退化为排序第一的候选
        return { move: rootMoves[0], score: 0, depth: 0, nodes: nodeCount, root: [] };
      }
      return bestResult;
    }

    return {
      N, SIZE, EMPTY, BLACK, WHITE, WIN,
      isForbiddenRule, overlineWins,
      xyToPos, posToXY, xyToPosT, posToXYT, posName,
      fromP, toP,
      checkWinAt, runLenAt,
      isForbiddenPoint, analyzeBlackPoint,
      genCandidates, fivePoints, desperateMove,
      search, makeState,
    };
  });


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

/* ============================================================
 * HullQin 游戏助手 · 整合版统一 GUI 壳
 * 遍历 HQ.games，按当前路由自动挂载对应游戏的面板；
 * SPA 切换路由时自动卸载旧游戏、挂载新游戏。
 * 特殊规则：斗兽棋（dsq.canShow）需检测到棋盘（开始游戏）后才显示面板。
 * ============================================================ */
(function () {
  'use strict';
  HQ.onReady(function () {
    const shell = document.createElement('div');
    shell.id = 'hqAI';
    const style = document.createElement('style');
    style.textContent = `
      #hqAI{position:fixed;top:10px;right:10px;z-index:100000;width:fit-content;
        background:#0f172a;border:1px solid rgba(99,102,241,.45);border-radius:14px;
        box-shadow:0 8px 30px rgba(0,0,0,.5);color:#e2e8f0;user-select:none;overflow:hidden;
        font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}
      #hqAI .hd{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;
        background:linear-gradient(90deg,rgba(99,102,241,.28),rgba(56,189,248,.14))}
      #hqAI .hd .ttl{font-weight:700;font-size:13px;letter-spacing:.3px}
      #hqAI .hd .game{font-size:11.5px;color:#7dd3fc}
      #hqAI .hd .mini{margin-left:auto;cursor:pointer;color:#94a3b8;font-size:13px;padding:0 4px;line-height:1}
      #hqAI .hd .mini:hover{color:#e2e8f0}
      #hqAI.min .bd{display:none}
      #hqAI .bd{padding:0;background:rgba(15,23,42,.93)}
      #hqAI .bd > *{border-radius:0 !important;box-shadow:none !important;border-top:none !important}
      #hqAI .tip{padding:6px 12px;font-size:11px;color:#64748b}
    `;
    document.head.appendChild(style);
    shell.innerHTML = `
      <div class="hd">
        <span class="ttl">🎮 HullQin 助手</span>
        <span class="game"></span>
        <span class="mini">—</span>
      </div>
      <div class="bd"></div>`;
    document.body.appendChild(shell);

    const hd = shell.querySelector('.hd');
    const gameLabel = shell.querySelector('.game');
    const bd = shell.querySelector('.bd');
    shell.querySelector('.mini').addEventListener('click', () => shell.classList.toggle('min'));
    HQ.makeDraggable(shell, hd, 'mini');

    let current = null;

    function pick() {
      return HQ.games.find(g => g.route && g.route.test(location.pathname)) || null;
    }
    function mount(g) {
      bd.innerHTML = '';
      shell.style.display = '';
      gameLabel.textContent = '· ' + g.icon + ' ' + g.name;
      g.mount(bd);
      current = g;
      initedFor = location.pathname;
    }
    // 初始隐藏，交给调度循环按路由挂载/显示
    shell.style.display = 'none';

    setInterval(function () {
      const g = pick();
      if (!g) {
        // 不在五个游戏页面：隐藏壳并卸载面板
        if (current) { bd.innerHTML = ''; current = null; }
        shell.style.display = 'none';
        return;
      }
      if (g !== current) mount(g);
      // 斗兽棋等：canShow 不满足时隐藏整壳（如斗兽棋未开局）
      shell.style.display = g.canShow ? (g.canShow() ? '' : 'none') : '';
      if (current === g) g.tick();
    }, 450);
    console.log('[HQ助手·整合版] 已加载 ✓ 共注册 ' + HQ.games.length + ' 个游戏：' + HQ.games.map(x => x.name).join('/'));
  });
})();

})();
