// ==UserScript==
// @name         斗兽棋 AI 助手（game.hullqin.cn）
// @namespace    dsq-ai-helper
// @version      1.3.2
// @description  桌游合集斗兽棋的 AI 助手：💡提示（高亮最佳走法）与 🤖自动代走，内置 negamax + αβ 剪枝 + 静态搜索 + 置换表引擎，支持可调思考深度与思考时间；规则 1:1 逆向自游戏源码。朋友间娱乐使用。
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



HQ.mountStandalone();
})();
