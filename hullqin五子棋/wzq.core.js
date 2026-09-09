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

