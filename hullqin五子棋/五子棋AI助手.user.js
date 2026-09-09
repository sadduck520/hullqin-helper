// ==UserScript==
// @name         五子棋 AI 助手（game.hullqin.cn）
// @namespace    wzq-ai-helper
// @version      1.2.1
// @description  桌游合集五子棋的 AI 助手：💡提示（高亮最佳落点）与 🤖自动落子，negamax + αβ + 置换表引擎，支持全部 8 种规则（含禁手判定：三三/四四/长连）。朋友间娱乐使用。
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

HQ.mountStandalone();
})();
