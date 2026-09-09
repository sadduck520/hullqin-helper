/**
 * 斗兽棋 300 局自对弈测试（本地运行，不需要联网、不需要 AI）
 *
 * 运行方式（在脚本所在目录，或直接复制完整路径）：
 *   node selftest300.js
 *
 * 可选参数（都有默认值，直接用上面的命令即可）：
 *   --games 300     局数（默认 300）
 *   --budget 1000   每步思考毫秒数（默认 1000）
 *   --cap 300       单局硬性回合上限（默认 300，超过判和，防死局）
 *   --jobs 12       并行进程数（默认 12，可以按自己机器核数调）
 *
 * 与引擎的判定约定（实测用，不等同于官网规则）：
 *   - 攻入对方兽穴 / 吃光对方棋子  => 胜
 *   - 轮到的一方无棋可走（困毙）    => 对方胜
 *   - 相同局面 + 相同行棋方 出现 3 次 => 和（三同局面判和，防死局）
 *   - 超过 --cap 回合仍未分胜负      => 和（兜底，防死局）
 *
 * 输出：
 *   - 控制台实时进度（每 10 局）与最终汇总
 *   - results-<时间戳>/results.csv  每局一行明细（每局立即落盘，中断不丢已跑数据）
 *   - results-<时间戳>/summary.txt  最终汇总
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

// ---------- 参数 ----------
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

// --engine core|mcts 选择自对弈引擎（默认 mcts；要生成开局书请用 --engine core）
function strArg(name, def) {
  const ev = process.env['DSQ_' + name.toUpperCase()];
  if (ev !== undefined && ev !== '') return ev;
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const ENGINE_MODE = strArg('engine', 'core'); // 默认 negamax（core）；MCTS 不再默认使用
const ENGINE = ENGINE_MODE === 'core'
  ? './engine.core.js'
  : (fs.existsSync('./engine.mcts.js') ? './engine.mcts.js' : './engine.core.js'); // 须同目录
// --depth N：固定迭代深度（0=按时间预算）
const DEPTH = arg('depth', 0);
if (DEPTH > 0) process.env.DSQ_FIXED_DEPTH = String(DEPTH);
// 参数经环境变量传给 worker（worker 读不到命令行参数）
process.env.DSQ_GAMES = String(GAMES);
process.env.DSQ_BUDGET = String(BUDGET);
process.env.DSQ_CAP = String(CAP);
process.env.DSQ_JOBS = String(JOBS);
process.env.DSQ_DEPTH = String(DEPTH);
process.env.DSQ_ENGINE = ENGINE;
const TRACE = Number(process.env.DSQ_TRACE) || arg('trace', 0); // 记录每局前 N 步（env 优先，确保 worker 一致）
process.env.DSQ_TRACE = String(TRACE);

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + '分' + String(s).padStart(2, '0') + '秒';
}

// 单局对弈（在 worker 里执行）
function playGameOnce(E) {
  const pos = Int8Array.from(E.INIT_POS);
  let side = E.RED;
  let plies = 0;
  const hist = [E.posKey(pos)];
  const seen = new Map();
  const key0 = E.posKey(pos) + '|' + side;
  seen.set(key0, 1);

  let first = null; // 红方首步信息
  const traceMoves = [];
  let stalePly = 0;   // 自上次吃子以来的半回合数

  while (plies < CAP) {
    // 三同局面判和：轮到自己走之前统计，同一局面+同一行棋方第 3 次出现 => 和
    const key = E.posKey(pos) + '|' + side;
    const cnt = (seen.get(key) || 0) + 1;
    seen.set(key, cnt);
    if (cnt >= 3) {
      return { winner: -1, outcome: 'repetition', plies: plies, first: first, trace: TRACE ? traceMoves.join('|') : '' };
    }

    const r = E.search(pos, side, BUDGET, hist.slice(-40), { stalePly });
    if (!r.move) {
      // 无棋可走 = 败
      return { winner: 1 - side, outcome: 'noMoves', plies: plies, first: first, trace: TRACE ? traceMoves.join('|') : '' };
    }
    const mv = r.move;
    if (plies === 0) {
      first = { name: E.NAMES[mv.pieceId % 8], from: mv.from, to: mv.to };
    }

    // 合法性自检（如果出现非法走法会直接报错停下来）
    const board = E.boardFrom(pos);
    const legal = E.genMoves(board, mv.pieceId, pos[mv.pieceId]);
    if (!legal.includes(mv.to)) {
      throw new Error('非法走法: 棋子' + mv.pieceId + ' -> ' + mv.to);
    }
    if (TRACE > 0 && plies < TRACE) traceMoves.push(mv.from + '->' + mv.to);

    const victim = board[mv.to];
    board[pos[mv.pieceId]] = E.MAP_DEAD;
    board[mv.to] = mv.pieceId;
    if (victim >= 0) pos[victim] = E.DEAD;
    pos[mv.pieceId] = mv.to;
    hist.push(E.posKey(pos));
    // 无吃子回合计数（供引擎紧迫感评估）
    stalePly = victim >= 0 ? 0 : stalePly + 1;

    // 胜：攻入对方兽穴
    if (mv.to === E.DENS[1 - side]) {
      return { winner: side, outcome: 'den', plies: plies + 1, first: first, trace: TRACE ? traceMoves.join('|') : '' };
    }
    // 胜：吃光对方
    const opp = 1 - side;
    const oppAlive = [];
    for (let i = opp * 8; i < opp * 8 + 8; i++) {
      if (pos[i] >= 0 && pos[i] < E.DEAD) oppAlive.push(i);
    }
    if (oppAlive.length === 0) {
      return { winner: side, outcome: 'exterminate', plies: plies + 1, first: first, trace: TRACE ? traceMoves.join('|') : '' };
    }
    // 胜：对方无棋可走
    const ob = E.boardFrom(pos);
    if (!oppAlive.some(id2 => E.genMoves(ob, id2, pos[id2]).length > 0)) {
      return { winner: side, outcome: 'noMoves', plies: plies + 1, first: first, trace: TRACE ? traceMoves.join('|') : '' };
    }

    side = 1 - side;
    plies++;
  }
  // 回合上限兜底：判和
  return { winner: -1, outcome: 'cap', plies: plies, first: first, trace: TRACE ? traceMoves.join('|') : '' };
}

// ================= worker 分支 =================
if (!isMainThread) {
  const E = require(ENGINE);
  parentPort.on('message', (msg) => {
    if (msg.type === 'job') {
      const r = playGameOnce(E);
      parentPort.postMessage({ type: 'result', id: msg.id, ...r });
    } else if (msg.type === 'done') {
      process.exit(0);
    }
  });
} else {
  // ================= 主线程 =================
  let E = null;
  try {
    E = require(ENGINE);
  } catch (e) {
    console.error('找不到 engine.core.js：请确认本脚本与 engine.core.js 放在同一目录。');
    console.error(String(e));
    process.exit(1);
  }
  if (!E || typeof E.search !== 'function') {
    console.error('engine.core.js 加载失败或格式不对。');
    process.exit(1);
  }

  console.log('==== 斗兽棋 ' + GAMES + ' 局自对弈测试（引擎：' + ENGINE + '）====');
  console.log('配置：每步 ' + BUDGET + 'ms | 回合上限 ' + CAP + ' | 并行 ' + JOBS + ' 进程');
  console.log('判定：三同局面判和 + ' + CAP + ' 回合上限兜底；无棋可走判对方胜');
  console.log('预计耗时：多数机器约 1-2.5 小时；个别打满回合上限的死局会更慢（可调 --cap）\n');

  // 输出目录：results-时间戳
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const outDir = path.join(__dirname, 'results-' + ts);
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'results.csv');
  const headerBase = '\ufeffgame_id,winner,outcome,plies,first_name,first_from,first_to';
fs.writeFileSync(csvPath, headerBase + (TRACE > 0 ? ',trace' : '') + '\n');
  console.log('结果保存目录：' + outDir + '\n');

  // 引擎自检
  try {
    E.search(Int8Array.from(E.INIT_POS), E.RED, 5);
    console.log('引擎自检通过。\n');
  } catch (e) {
    console.error('引擎自检失败：' + String(e));
    process.exit(1);
  }

  const t0 = Date.now();
  let nextId = 0;          // 下一个待发任务
  let completed = 0;       // 已完成局数
  let aliveWorkers = 0;    // 仍在运行的 worker 数
  const stats = { red: 0, green: 0, draw: 0, outcomes: {}, plies: [], firsts: {} };

  function onResult(msg, w) {
    const r = msg;
    if (r.winner === E.RED) stats.red++;
    else if (r.winner === E.GREEN) stats.green++;
    else stats.draw++;
    stats.outcomes[r.outcome] = (stats.outcomes[r.outcome] || 0) + 1;
    stats.plies.push(r.plies);
    if (r.first) {
      const k = r.first.name + ' ' + r.first.from + '->' + r.first.to;
      stats.firsts[k] = (stats.firsts[k] || 0) + 1;
    }

    // 立即落盘（中断也不丢已跑数据）
    const line = r.id + ',' + r.winner + ',' + r.outcome + ',' + r.plies + ','
      + (r.first ? r.first.name : '') + ',' + (r.first ? r.first.from : '') + ',' + (r.first ? r.first.to : '') + (TRACE > 0 ? ',' + (r.trace || '') : '') + '\n';
    fs.appendFileSync(csvPath, line);

    // 发下一个任务，或让该 worker 结束
    if (nextId < GAMES) {
      w.postMessage({ type: 'job', id: nextId++ });
    } else {
      w.postMessage({ type: 'done' });
    }

    completed++;
    if (completed % 10 === 0 || completed === GAMES) {
      const el = (Date.now() - t0) / 1000;
      const eta = el / completed * (GAMES - completed);
      console.log('[进度] ' + completed + '/' + GAMES
        + ' | 红 ' + stats.red + ' | 绿 ' + stats.green + ' | 和 ' + stats.draw
        + ' | 已用 ' + fmt(el) + ' | 预计还剩 ' + fmt(eta));
    }
    if (completed === GAMES) finish();
  }

  function finish() {
    const el = (Date.now() - t0) / 1000;
    const n = GAMES;
    const redP = (100 * stats.red / n).toFixed(1);
    const greenP = (100 * stats.green / n).toFixed(1);
    const drawP = (100 * stats.draw / n).toFixed(1);
    const ps = stats.plies.slice().sort((a, b) => a - b);
    const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
    const med = ps[(ps.length / 2) | 0];

    const lines = [];
    lines.push('==== 斗兽棋 ' + GAMES + ' 局自对弈汇总 ====');
    lines.push('配置：每步 ' + BUDGET + 'ms | 回合上限 ' + CAP + ' | 并行 ' + JOBS);
    lines.push('先手红 ' + stats.red + '（' + redP + '%） | 后手绿 ' + stats.green + '（' + greenP + '%） | 和棋 ' + stats.draw + '（' + drawP + '%）');
    lines.push('结束方式分布：' + JSON.stringify(stats.outcomes));
    lines.push('平均回合数 ' + avg.toFixed(1) + ' | 中位数 ' + med + ' | 最长 ' + ps[ps.length - 1]);
    lines.push('红方首步分布（前10）：' + JSON.stringify(Object.entries(stats.firsts).sort((a, b) => b[1] - a[1]).slice(0, 10)));
    lines.push('总耗时 ' + fmt(el));
    const text = lines.join('\n') + '\n';

    console.log('\n' + text);
    fs.writeFileSync(path.join(outDir, 'summary.txt'), '\ufeff' + text);
    console.log('汇总已保存：' + path.join(outDir, 'summary.txt'));
    console.log('明细已保存：' + csvPath);
    process.exit(0);
  }

  // 启动 workers
  for (let i = 0; i < JOBS; i++) {
    const w = new Worker(__filename);
    aliveWorkers++;
    w.on('message', (msg) => {
      if (msg.type === 'result') onResult(msg, w);
    });
    w.on('error', (e) => console.error('[worker错误] ' + String(e)));
    w.on('exit', (code) => {
      aliveWorkers--;
      if (code !== 0) console.error('[worker退出码] ' + code);
    });
    if (nextId < GAMES) w.postMessage({ type: 'job', id: nextId++ });
    else w.postMessage({ type: 'done' });
  }
}








