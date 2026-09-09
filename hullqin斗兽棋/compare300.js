/**
 * 双引擎对比测试（本地运行）——默认：引擎A=engine.core.js（negamax 增强版），引擎B=对比引擎
 *
 * 运行方式（脚本与引擎文件放在同一目录）：
 *   node compare300.js
 *   node compare300.js --engineA ./engine.core.js --engineB ./engine.core.bak.js
 *
 * 可选参数（都有默认值）：
 *   --games 300     局数（默认 300；须为偶数，保证先后手各半）
 *   --budget 1000   每步思考毫秒数（默认 1000；--depth 模式下成为兜底值）
 *   --depth N       固定迭代深度（0=按时间预算，>0=每步固定搜 N 层、不限时）
 *   --cap 600       单局硬性回合上限（默认 600，超过判和，防死局）
 *   --jobs 12       并行进程数（默认 12，按机器核数调）
 *   --engineA path  引擎A（显示/统计为 A）
 *   --engineB path  引擎B（显示/统计为 B）
 *   --book 0|1      引擎B 开局书开关（默认 1；配合 book.json）
 *
 * 先后手平衡（重点）：
 *   - 前一半局：引擎B 执红（先手），引擎A 执绿（后手）
 *   - 后一半局：引擎A 执红（先手），引擎B 执绿（后手）
 *
 * 判和口径（与 selftest300.js 一致）：
 *   - 相同局面 + 相同行棋方出现 3 次 => 和（三同局面）
 *   - 超过 --cap 回合 => 和（兜底）
 *   - 轮到一方无棋可走 => 对方胜
 *
 * 输出：
 *   - 控制台实时进度与最终汇总
 *   - compare-<时间戳>/results.csv  每局一行（含双方引擎 A/B、胜方 A/B、结束方式）
 *   - compare-<时间戳>/summary.txt  最终汇总（总胜率 + 按先后手拆分）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

function arg(name, def) {
  const ev = process.env['DSQ_' + name.toUpperCase()];
  if (ev !== undefined && ev !== '') { const n = Number(ev); if (Number.isFinite(n)) return n; }
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    const n = Number(process.argv[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return def;
}
const GAMES = arg('games', 300);
const BUDGET = arg('budget', 1000);
const CAP = arg('cap', 300);
const JOBS = Math.max(1, arg('jobs', 12));
const BOOK = arg('book', 1);          // 开局书开关：1=开(默认) 0=关
const BOOK_TOPN = arg('bookTopN', 4);  // 每个局面取出现次数前 N 的走法
const BOOK_PROB = arg('bookProb', 1); // 按概率使用书中走法（0~1）
const BOOK_MINCNT = arg('bookMinCnt', 2); // 出现次数低于此值的走法不用
// --bookSide red|green|both 只让指定一方用书（默认 both）
function strArg(name, def) {
  const ev = process.env['DSQ_' + name.toUpperCase()];
  if (ev !== undefined && ev !== '') return ev;
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const BOOK_SIDE = strArg('bookSide', 'both');
const DEPTH = arg('depth', 0); // 0=按时间预算；>0=固定迭代深度（时间预算作废）
const TRACE = Number(process.env.DSQ_TRACE) || arg('trace', 0); // 记录每局前 N 步（env 优先，确保 worker 一致）
process.env.DSQ_TRACE = String(TRACE);
// 开局书参数经环境变量传给 worker（MCTS 引擎读取；minimax 不受影响）
if (BOOK === 0) process.env.DSQ_BOOK_OFF = '1';
else {
  if (BOOK_TOPN > 0) process.env.DSQ_BOOK_TOPN = String(BOOK_TOPN);
  if (BOOK_PROB > 0) process.env.DSQ_BOOK_PROB = String(BOOK_PROB);
  if (BOOK_MINCNT > 0) process.env.DSQ_BOOK_MINCNT = String(BOOK_MINCNT);
  process.env.DSQ_BOOK_SIDE = BOOK_SIDE;
}
if (DEPTH > 0) process.env.DSQ_FIXED_DEPTH = String(DEPTH); // 深度参数必须经 env 传给 worker
if (GAMES % 2 !== 0) {
  console.error('--games 必须是偶数（保证双方先后手各半）');
  process.exit(1);
}

// 引擎路径可调：--engineA/--engineB（分别记为 引擎A/引擎B，用于新旧引擎对比）
const MINIMAX = strArg('engineA', './engine.core.js'); // 当前主力：negamax+αβ+静态搜索+置换表
const MCTS = strArg('engineB', './engine.mcts.js');    // 对比用：MCTS 或旧引擎备份
// 参数经环境变量传给 worker（worker 读不到命令行参数）
process.env.DSQ_GAMES = String(GAMES);
process.env.DSQ_BUDGET = String(BUDGET);
process.env.DSQ_CAP = String(CAP);
process.env.DSQ_JOBS = String(JOBS);
process.env.DSQ_BOOK = String(BOOK);
process.env.DSQ_BOOK_TOPN = String(BOOK_TOPN);
process.env.DSQ_BOOK_PROB = String(BOOK_PROB);
process.env.DSQ_BOOK_MINCNT = String(BOOK_MINCNT);
process.env.DSQ_DEPTH = String(DEPTH);
process.env.DSQ_ENGINEA = MINIMAX;
process.env.DSQ_ENGINEB = MCTS;

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + '分' + String(s).padStart(2, '0') + '秒';
}

// 单局对弈。id 决定配对：id < GAMES/2 => MCTS 红方；否则 minimax 红方。
function playGameOnce(minimaxE, mctsE, id, budget, cap) {
  const R = minimaxE; // 规则函数两种引擎完全一致
  const mctsRed = id < GAMES / 2;
  const pos = Int8Array.from(R.INIT_POS);
  let side = R.RED, plies = 0;
  const hist = [R.posKey(pos)];
  const seen = new Map();
  seen.set(R.posKey(pos) + '|' + side, 1);
  let first = null;
  let bookUses = 0; // MCTS 开局书使用次数
  const traceMoves = [];
  let stalePly = 0;   // 自上次吃子以来的半回合数

  while (plies < cap) {
    const key = R.posKey(pos) + '|' + side;
    const cnt = (seen.get(key) || 0) + 1;
    seen.set(key, cnt);
    if (cnt >= 3) return { winnerSide: -1, outcome: 'repetition', plies: plies, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };

    // 轮到当前行棋方，选对应引擎
    const isRedMove = side === R.RED;
    const engine = (isRedMove ? mctsRed : !mctsRed) ? mctsE : minimaxE;
    const engineName = engine === mctsE ? 'B' : 'A';
    const r = engine.search(pos, side, budget, hist.slice(-40), { stalePly });
    if (r.book) bookUses++;
    if (!r.move) {
      return { winnerSide: 1 - side, outcome: 'noMoves', plies: plies, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };
    }
    const mv = r.move;
    if (plies === 0) {
      first = { name: R.NAMES[mv.pieceId % 8], from: mv.from, to: mv.to };
    }

    const board = R.boardFrom(pos);
    const legal = R.genMoves(board, mv.pieceId, pos[mv.pieceId]);
    if (!legal.includes(mv.to)) {
      throw new Error('非法走法 ' + engineName + ': 棋子' + mv.pieceId + ' -> ' + mv.to);
    }
    if (TRACE > 0 && plies < TRACE) traceMoves.push(mv.from + '->' + mv.to);

    const victim = board[mv.to];
    board[pos[mv.pieceId]] = R.MAP_DEAD;
    board[mv.to] = mv.pieceId;
    if (victim >= 0) pos[victim] = R.DEAD;
    pos[mv.pieceId] = mv.to;
    hist.push(R.posKey(pos));
    stalePly = victim >= 0 ? 0 : stalePly + 1;

    if (mv.to === R.DENS[1 - side]) return { winnerSide: side, outcome: 'den', plies: plies + 1, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };
    const opp = 1 - side;
    const oppAlive = [];
    for (let i = opp * 8; i < opp * 8 + 8; i++) if (pos[i] >= 0 && pos[i] < R.DEAD) oppAlive.push(i);
    if (oppAlive.length === 0) return { winnerSide: side, outcome: 'exterminate', plies: plies + 1, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };
    const ob = R.boardFrom(pos);
    if (!oppAlive.some(id2 => R.genMoves(ob, id2, pos[id2]).length > 0)) return { winnerSide: side, outcome: 'noMoves', plies: plies + 1, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };

    side = 1 - side;
    plies++;
  }
  return { winnerSide: -1, outcome: 'cap', plies: plies, first: first, bookUses: bookUses, trace: TRACE ? traceMoves.join('|') : '' };
}

// ================= worker 分支 =================
if (!isMainThread) {
  const minimaxE = require(MINIMAX);
  const mctsE = require(MCTS);
  parentPort.on('message', (msg) => {
    if (msg.type === 'job') {
      const r = playGameOnce(minimaxE, mctsE, msg.id, BUDGET, CAP);
      parentPort.postMessage({ type: 'result', id: msg.id, ...r });
    } else if (msg.type === 'done') {
      process.exit(0);
    }
  });
} else {
  // ================= 主线程 =================
  let minimaxE, mctsE;
  try {
    minimaxE = require(MINIMAX);
    mctsE = require(MCTS);
  } catch (e) {
    console.error('引擎加载失败：请确认本脚本与 engine.core.js / engine.mcts.js 同一目录。');
    console.error(String(e));
    process.exit(1);
  }
  if (minimaxE === mctsE) {
    console.error('两个引擎指向同一对象（engine.mcts.js 应返回独立副本）。');
    process.exit(1);
  }
  if (!minimaxE.search || !mctsE.search || !minimaxE.genAll || !mctsE.genAll) {
    console.error('引擎格式不对。');
    process.exit(1);
  }

  console.log('==== A vs B 引擎 ' + GAMES + ' 局对比 ====');
  console.log('引擎A=' + MINIMAX + ' | 引擎B=' + MCTS);
  console.log('配对：前 ' + (GAMES / 2) + ' 局 引擎B执红(先手) | 后 ' + (GAMES / 2) + ' 局 引擎A执红(先手)');
  console.log('配置：每步 ' + BUDGET + 'ms | 回合上限 ' + CAP + ' | 并行 ' + JOBS + ' 进程');
  console.log('判定：三同局面判和 + ' + CAP + ' 回合上限兜底；无棋可走判对方胜');
  if (DEPTH > 0) console.log('深度模式：固定迭代到 ' + DEPTH + ' 层（每步不限时）');
  if (BOOK === 0) console.log('开局书：关闭（--book 0）');
  else console.log('开局书：开（topN=' + BOOK_TOPN + ' 概率=' + BOOK_PROB + ' minCnt=' + BOOK_MINCNT + ' 适用方=' + BOOK_SIDE + '）——引擎B 前几步按 minimax 自对弈谱走');
  if (BOOK !== 0 && !fs.existsSync(path.join(__dirname, 'book.json'))) console.log('提示：未找到 book.json，开局书未生效（先运行 node openbook.js 生成）');
  console.log('预计耗时：多数机器约 1.5-3 小时（视死局与机器情况）；可调 --budget/--cap/--jobs\n');

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const outDir = path.join(__dirname, 'compare-' + ts);
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'results.csv');
  const headerBase = '\ufeffgame_id,red_engine,winner_side,winner_engine,outcome,plies,first_name,first_from,first_to';
fs.writeFileSync(csvPath, headerBase + (TRACE > 0 ? ',trace' : '') + '\n');
  console.log('结果保存目录：' + outDir + '\n');

  const t0 = Date.now();
  let nextId = 0;
  let completed = 0;
  const stats = { winsB: 0, winsA: 0, draws: 0, outcomes: {}, plies: [], firsts: {}, bookUses: 0, bookGames: 0 };
  // 按配对拆分的胜负：mcts红 / mcts绿 / mini红 / mini绿
  const byColor = { BRed: { w: 0, l: 0, d: 0 }, BGreen: { w: 0, l: 0, d: 0 }, ARed: { w: 0, l: 0, d: 0 }, AGreen: { w: 0, l: 0, d: 0 } };

  function winnerEngine(ws, mctsRed) {
    if (ws === -1) return 'draw';
    if (ws === 0) return mctsRed ? 'B' : 'A';
    return mctsRed ? 'A' : 'B';
  }

  function onResult(msg, w) {
    const mctsRed = msg.id < GAMES / 2;
    const redEngine = mctsRed ? 'B' : 'A';
    const we = winnerEngine(msg.winnerSide, mctsRed);
    if (we === 'B') stats.winsB++;
    else if (we === 'A') stats.winsA++;
    else stats.draws++;
    stats.outcomes[msg.outcome] = (stats.outcomes[msg.outcome] || 0) + 1;
    stats.bookUses += (msg.bookUses || 0);
    if (msg.bookUses > 0) stats.bookGames++;
    stats.plies.push(msg.plies);
    if (msg.first) {
      const k = msg.first.name + ' ' + msg.first.from + '->' + msg.first.to;
      stats.firsts[k] = (stats.firsts[k] || 0) + 1;
    }
    // byColor：执红方胜负（红胜=执红引擎胜；绿胜=执绿引擎胜；和）
    const redKey = redEngine + 'Red';
    const greenKey = (mctsRed ? 'A' : 'B') + 'Green';
    if (msg.winnerSide === -1) { byColor[redKey].d++; byColor[greenKey].d++; }
    else if (msg.winnerSide === 0) byColor[redKey].w++;
    else byColor[greenKey].w++;

    const line = msg.id + ',' + redEngine + ',' + msg.winnerSide + ',' + we + ',' + msg.outcome + ',' + msg.plies + ','
      + (msg.first ? msg.first.name : '') + ',' + (msg.first ? msg.first.from : '') + ',' + (msg.first ? msg.first.to : '') + (TRACE > 0 ? ',' + (msg.trace || '') : '') + '\n';
    fs.appendFileSync(csvPath, line);

    if (nextId < GAMES) w.postMessage({ type: 'job', id: nextId++ });
    else w.postMessage({ type: 'done' });

    completed++;
    if (completed % 10 === 0 || completed === GAMES) {
      const el = (Date.now() - t0) / 1000;
      const eta = el / completed * (GAMES - completed);
      console.log('[进度] ' + completed + '/' + GAMES
        + ' | 引擎B胜 ' + stats.winsB + ' | 引擎A胜 ' + stats.winsA + ' | 和 ' + stats.draws
        + ' | 已用 ' + fmt(el) + ' | 预计还剩 ' + fmt(eta));
    }
    if (completed === GAMES) finish();
  }

  function finish() {
    const el = (Date.now() - t0) / 1000;
    const n = GAMES, half = GAMES / 2;
    const mctsP = (100 * stats.winsB / n).toFixed(1);
    const miniP = (100 * stats.winsA / n).toFixed(1);
    const drawP = (100 * stats.draws / n).toFixed(1);
    const ps = stats.plies.slice().sort((a, b) => a - b);
    const avg = ps.reduce((a, b) => a + b, 0) / ps.length;

    const lines = [];
    lines.push('==== A vs B 引擎 ' + GAMES + ' 局对比汇总 ====');
    lines.push('配置：每步 ' + BUDGET + 'ms | 回合上限 ' + CAP + ' | 并行 ' + JOBS);
    lines.push('开局书：' + (BOOK === 0 ? '关闭' : '开（topN ' + BOOK_TOPN + '，概率 ' + BOOK_PROB + '，minCnt ' + BOOK_MINCNT + '，适用方 ' + BOOK_SIDE + '）') + ' | 引擎B 书中走法共 ' + stats.bookUses + ' 次，涉及 ' + stats.bookGames + '/' + n + ' 局');
    lines.push('配对：前 ' + half + ' 局 引擎B执红(先手) | 后 ' + half + ' 局 引擎A执红(先手)');
    lines.push('引擎B 总胜 ' + stats.winsB + '（' + mctsP + '%） | 引擎A 总胜 ' + stats.winsA + '（' + miniP + '%） | 和棋 ' + stats.draws + '（' + drawP + '%）');
    lines.push('');
    lines.push('按先后手拆分（先手=执红，后手=执绿）：');
    lines.push('  引擎B 执红(先手)：胜 ' + byColor.BRed.w + ' / 负 ' + (half - byColor.BRed.w - byColor.BRed.d) + ' / 和 ' + byColor.BRed.d + '（' + (100 * byColor.BRed.w / half).toFixed(1) + '%）');
    lines.push('  引擎B 执绿(后手)：胜 ' + byColor.BGreen.w + ' / 负 ' + (half - byColor.BGreen.w - byColor.BGreen.d) + ' / 和 ' + byColor.BGreen.d + '（' + (100 * byColor.BGreen.w / half).toFixed(1) + '%）');
    lines.push('  引擎A 执红(先手)：胜 ' + byColor.ARed.w + ' / 负 ' + (half - byColor.ARed.w - byColor.ARed.d) + ' / 和 ' + byColor.ARed.d + '（' + (100 * byColor.ARed.w / half).toFixed(1) + '%）');
    lines.push('  引擎A 执绿(后手)：胜 ' + byColor.AGreen.w + ' / 负 ' + (half - byColor.AGreen.w - byColor.AGreen.d) + ' / 和 ' + byColor.AGreen.d + '（' + (100 * byColor.AGreen.w / half).toFixed(1) + '%）');
    lines.push('');
    lines.push('结束方式分布：' + JSON.stringify(stats.outcomes));
    lines.push('平均回合数 ' + avg.toFixed(1) + ' | 中位数 ' + ps[(ps.length / 2) | 0] + ' | 最长 ' + ps[ps.length - 1]);
    lines.push('（所有局）先手方首步分布（前10）：' + JSON.stringify(Object.entries(stats.firsts).sort((a, b) => b[1] - a[1]).slice(0, 10)));
    lines.push('总耗时 ' + fmt(el));
    const text = lines.join('\n') + '\n';

    console.log('\n' + text);
    fs.writeFileSync(path.join(outDir, 'summary.txt'), '\ufeff' + text);
    console.log('汇总已保存：' + path.join(outDir, 'summary.txt'));
    console.log('明细已保存：' + csvPath);
    console.log('解读提示：win率约 50% 视为接近；差距 ≥10 个百分点才算明显。'); 
    process.exit(0);
  }

  for (let i = 0; i < JOBS; i++) {
    const w = new Worker(__filename);
    w.on('message', (msg) => {
      if (msg.type === 'result') onResult(msg, w);
    });
    w.on('error', (e) => console.error('[worker错误] ' + String(e)));
    w.on('exit', (code) => {
      if (code !== 0) console.error('[worker退出码] ' + code);
    });
    if (nextId < GAMES) w.postMessage({ type: 'job', id: nextId++ });
    else w.postMessage({ type: 'done' });
  }
}
















