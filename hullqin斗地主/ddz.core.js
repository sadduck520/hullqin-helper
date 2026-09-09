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
