/**
 * 开局书生成器 —— 从 minimax 自对弈中统计高频开局走法，生成 book.json
 *
 * 运行方式（在脚本所在目录）：
 *   node openbook.js
 *
 * 可选参数（都有默认值）：
 *   --games 60     对弈局数（默认 60，越多覆盖越全、生成越慢）
 *   --budget 1000  每步思考毫秒数（默认 1000）
 *   --plies 6      书覆盖的半回合步数（默认 6 = 红/绿各 3 步；偶数结尾是红方）
 *   --cap 600      单局硬性回合上限（防死局）
 *   --jobs 12      并行进程数
 *   --out book.json 输出文件名
 *
 * 生成的 book.json 结构：
 *   table: { "局面key": [[from,to,count],...] }  局面 key 即 engine.posKey
 *   lines: [["红1->绿1->红2->...", count], ...]  完整开局线路（按次数降序）
 * 另有 book-summary.txt 输出各步高频走法摘要。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const GAMES = arg('games', 60);
const BUDGET = arg('budget', 1000);
const PLIES = arg('plies', 6);
const CAP = arg('cap', 600);
const JOBS = Math.max(1, arg('jobs', 12));
const OUT = arg('out', 'book.json');
const SUMMARY_ONLY = arg('summaryOnly', 0);
const ENGINE = './engine.core.js'; // 开局书来自 minimax（原算法）的自对弈统计

// 单局对弈：记录前 PLIES 步的“局面key -> 走法”，返回 trace
function playGameOnce(E) {
  const pos = Int8Array.from(E.INIT_POS);
  let side = E.RED;
  let plies = 0;
  const hist = [E.posKey(pos)];
  const seen = new Map();
  seen.set(E.posKey(pos) + '|' + side, 1);
  const trace = [];

  while (plies < CAP) {
    const key = E.posKey(pos) + '|' + side;
    const cnt = (seen.get(key) || 0) + 1;
    seen.set(key, cnt);
    if (cnt >= 3) return { winner: -1, outcome: 'repetition', plies, trace };

    const r = E.search(pos, side, BUDGET, hist.slice(-10));
    if (!r.move) return { winner: 1 - side, outcome: 'noMoves', plies, trace };
    const mv = r.move;

    if (plies < PLIES) trace.push({ k: E.posKey(pos), f: mv.from, t: mv.to });

    const board = E.boardFrom(pos);
    const legal = E.genMoves(board, mv.pieceId, pos[mv.pieceId]);
    if (!legal.includes(mv.to)) throw new Error('非法走法: ' + mv.pieceId + ' -> ' + mv.to);

    const victim = board[mv.to];
    board[pos[mv.pieceId]] = E.MAP_DEAD;
    board[mv.to] = mv.pieceId;
    if (victim >= 0) pos[victim] = E.DEAD;
    pos[mv.pieceId] = mv.to;
    hist.push(E.posKey(pos));

    if (mv.to === E.DENS[1 - side]) return { winner: side, outcome: 'den', plies: plies + 1, trace };
    const opp = 1 - side;
    const oppAlive = [];
    for (let i = opp * 8; i < opp * 8 + 8; i++) {
      if (pos[i] >= 0 && pos[i] < E.DEAD) oppAlive.push(i);
    }
    if (oppAlive.length === 0) return { winner: side, outcome: 'exterminate', plies: plies + 1, trace };
    const ob = E.boardFrom(pos);
    if (!oppAlive.some(id2 => E.genMoves(ob, id2, pos[id2]).length > 0)) {
      return { winner: side, outcome: 'noMoves', plies: plies + 1, trace };
    }

    side = 1 - side;
    plies++;
  }
  return { winner: -1, outcome: 'cap', plies, trace };
}


// ================= worker 分支 =================
if (!isMainThread) {
  const E = require(ENGINE);
  parentPort.on('message', (msg) => {
    if (msg.type === 'job') parentPort.postMessage({ type: 'result', id: msg.id, ...playGameOnce(E) });
    else if (msg.type === 'done') process.exit(0);
  });
} else {
  // ================= 主线程 =================
  let E = null;

  // 模拟一步（从给定初始数组出发），返回走完后的局面 key
  function posAfterFrom(pos16, f, t) {
    const pos = Int8Array.from(pos16);
    const board = E.boardFrom(pos);
    const pid = board[f]; // 棋子 id
    const victim = board[t];
    board[f] = E.MAP_DEAD;
    board[t] = pid;
    pos[pid] = t;
    if (victim >= 0) pos[victim] = E.DEAD;
    return pos;
  }
  function keyAfterFrom(pos16, f, t) { return posAfterFrom(pos16, f, t).join(','); }
  try { E = require(ENGINE); } catch (e) {
    console.error('找不到 engine.core.js，请确认在同一目录。');
    process.exit(1);
  }

  if (SUMMARY_ONLY) {
    try {
      const book = JSON.parse(fs.readFileSync(path.join(__dirname, OUT), 'utf8'));
      const text = makeSummary(book.table, book.lines || [], '摘要由已有 book.json 重算（未重跑对弈）');
      fs.writeFileSync(path.join(__dirname, 'book-summary.txt'), text);
      console.log(text);
      console.log('摘要已刷新：book-summary.txt（未重跑对弈）');
    } catch (e) {
      console.error('读取 ' + OUT + ' 失败：' + String(e));
      process.exit(1);
    }
    process.exit(0);
  }

  console.log('==== 开局书生成 ====');
  console.log('配置：' + GAMES + ' 局 | 每步 ' + BUDGET + 'ms | 记录前 ' + PLIES + ' 步 | 并行 ' + JOBS);
  console.log('预计耗时：' + GAMES + ' 局约 ' + Math.round(GAMES * 8 / 60) + '-' + Math.round(GAMES * 10 / 60) + ' 分钟\n');

  function makeSummary(plainTable, lineList, elText) {
    const out = [];
    out.push('==== 开局书摘要 ====');
    out.push('配置：' + GAMES + ' 局 | 每步 ' + BUDGET + 'ms | 覆盖前 ' + PLIES + ' 步');
    out.push('覆盖局面数：' + Object.keys(plainTable).length + ' | 覆盖线路数：' + lineList.length + '\n');

    const initKey = E.INIT_POS.join(',');
    const f1 = plainTable[initKey] || [];
    out.push('红方第一步（top8）：');
    for (const [f, t, c] of f1.slice(0, 8)) {
      const pid = E.boardFrom(E.INIT_POS)[f];
      out.push('  ' + E.NAMES[pid % 8] + ' ' + f + '->' + t + ' x' + c);
    }

    out.push('\n绿方应对（对最常见的红方首步，top3）：');
    for (const [f, t, c] of f1.slice(0, 4)) {
      const posAfter = posAfterFrom(E.INIT_POS, f, t);
      const g = plainTable[posAfter.join(',')] || [];
      out.push('  红方' + E.NAMES[(E.boardFrom(E.INIT_POS)[f]) % 8] + ' ' + f + '->' + t + '（x' + c + '）应对：');
      for (const [gf, gt, gc] of g.slice(0, 3)) {
        const gpid = E.boardFrom(posAfter)[gf];
        out.push('    绿方' + E.NAMES[gpid % 8] + ' ' + gf + '->' + gt + ' x' + gc);
      }
    }

    out.push('\n最常见完整线路（top10，红1|绿1|红2|绿2|红3|绿3）：');
    for (const [seq, c] of lineList.slice(0, 10)) {
      out.push('  ' + seq + ' x' + c);
    }

    out.push('\n' + elText);
    return '\ufeff' + out.join('\n') + '\n';
  }

  const t0 = Date.now();
  let nextId = 0, completed = 0;
  const table = new Map();      // 局面key -> Map('f|t' -> count)
  const lines = new Map();      // 线路 'f->t|f->t|...' -> count

  function onResult(r, w) {
    for (const step of r.trace) {
      let m = table.get(step.k);
      if (!m) { m = new Map(); table.set(step.k, m); }
      const mk = step.f + '|' + step.t;
      m.set(mk, (m.get(mk) || 0) + 1);
    }
    if (r.trace.length > 0) {
      const seq = r.trace.map(s => s.f + '->' + s.t).join('|');
      lines.set(seq, (lines.get(seq) || 0) + 1);
    }

    if (nextId < GAMES) w.postMessage({ type: 'job', id: nextId++ });
    else w.postMessage({ type: 'done' });

    completed++;
    if (completed % 10 === 0 || completed === GAMES) {
      console.log('[进度] ' + completed + '/' + GAMES + ' | 已用 ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
    if (completed === GAMES) finish();
  }

  function finish() {
    const plainTable = {};
    for (const [k, m] of table) {
      plainTable[k] = [...m.entries()].map(([mk, c]) => {
        const [f, t] = mk.split('|').map(Number);
        return [f, t, c];
      }).sort((a, b) => b[2] - a[2]);
    }
    const book = {
      game: 'dou_shou_qi',
      generated: new Date().toISOString(),
      config: { games: GAMES, budget: BUDGET, plies: PLIES, cap: CAP },
      table: plainTable,
      lines: [...lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50),
    };
    fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(book));

    const el = Math.round((Date.now() - t0) / 1000);
    const text = makeSummary(plainTable, book.lines, '生成耗时 ' + Math.floor(el / 60) + '分' + (el % 60) + '秒');
    fs.writeFileSync(path.join(__dirname, 'book-summary.txt'), text);
    console.log('\n' + text);
    console.log('开局书已保存：' + path.join(__dirname, OUT));
  }

  const workers = [];
  for (let i = 0; i < JOBS; i++) {
    const w = new Worker(__filename);
    workers.push(w);
    w.on('message', (msg) => { if (msg.type === 'result') onResult(msg, w); });
    w.on('error', (e) => { console.error('worker 错误：' + e); process.exit(1); });
  }
  for (let i = 0; i < Math.min(JOBS, GAMES); i++) workers[i].postMessage({ type: 'job', id: nextId++ });
}







