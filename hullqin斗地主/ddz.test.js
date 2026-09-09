// 斗地主引擎自测：牌型解析（对照站点 6139 规则）+ 压牌 + 拆牌 + 决策 + 记牌器
const E = require('./ddz.core.js');
let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`); }
}
// 造牌：rank -> 取一个 id（RANK 表 id 1..52 映射 rank；53大王 54小王）
const cardOf = (rank, suit = 0) => {
  if (rank === 54) return 53;   // 大王
  if (rank === 53) return 54;   // 小王
  for (let id = 1; id <= 52; id++) if (E.RANK[id] === rank) return id + suit * 13 > 52 ? id : (id % 13 === rank % 13 || E.RANK[id] === rank ? (suit === 0 ? id : -1) : -1) === -1 ? -1 : id;
  return -1;
};
// 简化：直接按 rank 找第 n 张
function cardsOf(rank, n = 1) {
  const out = [];
  const ids = [];
  for (let id = 1; id <= 52; id++) if (E.RANK[id] === rank) ids.push(id);
  if (rank === 53) ids.push(54);
  if (rank === 54) ids.push(53);
  for (let i = 0; i < n && i < ids.length; i++) out.push(ids[i]);
  if (n > ids.length) throw new Error('牌不够: rank ' + rank);
  return out;
}
const T = (...rs) => rs.map(r => cardsOf(r, 1)[0]);   // 每个rank取一张

console.log('== 1. 牌型解析（mode=true 斗地主） ==');
eq('单张', E.parseCards(true, T(10)), [1, 10]);
eq('对子', E.parseCards(true, cardsOf(7, 2)), [2, 7]);
eq('三张', E.parseCards(true, cardsOf(9, 3)), [3, 9]);
eq('三带一', E.parseCards(true, [...cardsOf(9, 3), ...T(3)]), [4, 9]);
eq('三带二', E.parseCards(true, [...cardsOf(9, 3), ...cardsOf(3, 2)]), [5, 9]);
eq('炸弹', E.parseCards(true, cardsOf(8, 4)), [100, 8]);
eq('王炸', E.parseCards(true, [53, 54]), [127, 0]);
eq('四带二单', E.parseCards(true, [...cardsOf(8, 4), ...T(3), ...T(4)]), [6, 8]);
eq('四带两对', E.parseCards(true, [...cardsOf(8, 4), ...cardsOf(3, 2), ...cardsOf(4, 2)]), [7, 8]);
eq('顺子5', E.parseCards(true, T(5, 6, 7, 8, 9)), [1 | 1 << 3, 5]);
eq('顺子12', E.parseCards(true, T(3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14)), [1 | 8 << 3, 3]);
eq('顺子含2不行', E.parseCards(true, T(11, 12, 13, 14, 15))[0], 0);
eq('顺子不连续', E.parseCards(true, T(5, 6, 7, 8, 10))[0], 0);
eq('连对3组', E.parseCards(true, [...cardsOf(5, 2), ...cardsOf(6, 2), ...cardsOf(7, 2)]), [2 | 4 << 2, 5]);
eq('飞机纯2组', E.parseCards(true, [...cardsOf(5, 3), ...cardsOf(6, 3)]), [3 | 1 << 3, 5]);
eq('飞机带单2组', E.parseCards(true, [...cardsOf(5, 3), ...cardsOf(6, 3), ...T(3), ...T(4)]), [4 | 1 << 3, 5]);
eq('飞机带对2组', E.parseCards(true, [...cardsOf(5, 3), ...cardsOf(6, 3), ...cardsOf(3, 2), ...cardsOf(4, 2)]), [5 | 1 << 3, 5]);
eq('乱牌', E.parseCards(true, T(3, 5, 9))[0], 0);
eq('对+单', E.parseCards(true, [...cardsOf(5, 2), ...T(9)])[0], 0);

console.log('== 2. mode=false（4人掼蛋变体） ==');
eq('无三带一', E.parseCards(false, [...cardsOf(9, 3), ...T(3)])[0], 0);
eq('无王炸(2王)', E.parseCards(false, [53, 54])[0], 0);
eq('连对仍可', E.parseCards(false, [...cardsOf(5, 2), ...cardsOf(6, 2), ...cardsOf(7, 2)])[0], 2 | 4 << 2);

console.log('== 3. 压牌 ==');
eq('大单压小单', E.canBeat(true, T(11), T(10)), true);
eq('小单压不过', E.canBeat(true, T(9), T(10)), false);
eq('对压单不行', E.canBeat(true, cardsOf(3, 2), T(10)), false);
eq('炸压对', E.canBeat(true, cardsOf(3, 4), cardsOf(13, 2)), true);
eq('王炸压炸', E.canBeat(true, [53, 54], cardsOf(13, 4)), true);
eq('炸压不过王炸', E.canBeat(true, cardsOf(13, 4), [53, 54]), false);
eq('长顺压短顺不行', E.canBeat(true, T(4, 5, 6, 7, 8), T(5, 6, 7, 8, 9)), false);
eq('同长顺比头', E.canBeat(true, T(6, 7, 8, 9, 10), T(5, 6, 7, 8, 9)), true);
eq('自由出(无last)', E.canBeat(true, T(3), []), true);

console.log('== 4. 拆牌 ==');
{
  // 34567 + 99 + 555 + 8 → 顺子+对+三张(带一) = 3手
  const hand = [...T(3, 4, 5, 6, 7), ...cardsOf(9, 2), ...cardsOf(5, 3), ...T(8)];
  eq('拆牌手数', E.handCount(hand, true) <= 4, true);
  const combos = E.decompose(hand, true);
  eq('拆牌覆盖全牌', combos.flatMap(c => c.cards).sort((a, b) => a - b).join(), [...hand].sort((a, b) => a - b).join());
}
{
  const hand = [...cardsOf(13, 4), 53, 54, ...T(3), ...T(4)];
  const combos = E.decompose(hand, true);
  eq('王炸保留', combos.some(c => c.type === E.Jokers), true);
  eq('炸弹保留', combos.some(c => c.type === E.Four), true);
}

console.log('== 5. 决策 ==');
{
  // 跟牌：出最小的能压的
  const hand = [...T(5, 9, 13), ...cardsOf(4, 2)];
  const play = E.followPlay(hand, T(8), true, {});
  eq('跟单用最小', E.rankOf(play[0]), 9);
  // 队友的大牌不压
  const pass = E.followPlay([...T(14), ...T(15)], T(14), true, { lastFromTeammate: true });
  eq('队友A不压', pass, null);
  // 只有炸弹但手数多（不紧迫）→ 不炸
  const noBoom = E.followPlay([...cardsOf(3, 4), ...T(9, 10, 11, 12, 13), ...cardsOf(7, 2)], cardsOf(13, 2), true, {});
  eq('不轻用炸弹', noBoom, null);
  // 手数少时炸
  const boom = E.followPlay([...cardsOf(3, 4), ...T(13)], cardsOf(13, 2), true, {});
  eq('快赢时用炸', E.parseCards(true, boom)[0] >= 100, true);
}
{
  // 领出：先出弱的多张组合
  const hand = [...T(3, 4, 5, 6, 7), ...cardsOf(9, 3), ...T(14), ...cardsOf(2 + 1, 0).slice(0, 0)];
  const play = E.leadPlay(hand, true, {});
  eq('领出有解', play && play.length > 0, true);
  const [t] = E.parseCards(true, play);
  eq('领出合法', t > 0, true);
}

console.log('== 6. 记牌器 ==');
{
  const my = T(15, 14);
  const played = [...cardsOf(3, 4), ...T(4, 5)];
  const rem = E.remainingRanks(my, played, [], 1);
  eq('3 已出完', rem.has(3), false);
  eq('2 还剩', rem.get(15), 3);      // 4张2，我没出过，手里1张 → 场上剩 3? 我手1张+没出 → 剩 4-1=3
  eq('大王没现', rem.get(54), 1);
}

console.log('== 7. 随机局自对弈冒烟（3人，合法性） ==');
{
  // 模拟对局：随机发牌，轮流 lead/follow，所有出牌必须过 canBeat，500 手内结束或判异常
  let err = null, games = 0, totalTurns = 0;
  for (let g = 0; g < 30 && !err; g++) {
    try {
      const ids = [];
      for (let id = 1; id <= 54; id++) ids.push(id);
      // shuffle
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      const hands = [ids.slice(0, 17), ids.slice(17, 34), ids.slice(34, 51)];
      const hole = ids.slice(51);
      hands[0].push(...hole);   // 0号当地主
      let turn = 0, last = [], lastFrom = -1, turns = 0;
      while (turns < 300) {
        turns++;
        const h = hands[turn];
        if (!h.length) { turn = (turn + 1) % 3; continue; }
        let play = null;
        if (!last.length || lastFrom === turn) play = E.leadPlay(h, true, {});
        else {
          play = E.followPlay(h, last, true, {
            lastFromTeammate: lastFrom !== 0 && turn !== 0,
            isLandlord: turn === 0,
          });
        }
        if (play) {
          if (!E.canBeat(true, play, lastFrom === turn ? [] : last)) throw new Error('非法出牌: ' + play.join(','));
          for (const c of play) {
            const ix = h.indexOf(c);
            if (ix < 0) throw new Error('手里没这牌');
            h.splice(ix, 1);
          }
          last = play; lastFrom = turn;
        } else {
          // pass 后轮转；连续两家 pass → 领出权回到 lastFrom
        }
        const alive = hands.filter(x => x.length);
        if (alive.length < 3) break;
        turn = (turn + 1) % 3;
      }
      games++; totalTurns += turns;
    } catch (e) { err = e; }
  }
  if (err) { fail++; console.log('  ✗ 自对弈异常:', err.message); }
  else { console.log(`  自对弈${games}局完成，平均${(totalTurns / games).toFixed(0)}手`); eq('自对弈无非法出牌', true, true); }
}

console.log('== 8. 状态解压（逆向 6139 的 g） ==');
{
  // 构造：3人局，玩家1原有牌1-5（其中1-3已打出→cardPositionList 置 8），6-10归玩家2，11-15归玩家3，16-18底牌(8|1=9)，其余未发(0)
  const pos = new Array(54).fill(0);
  for (let i = 1; i <= 5; i++) pos[i - 1] = 1;
  for (let i = 6; i <= 10; i++) pos[i - 1] = 2;
  for (let i = 11; i <= 15; i++) pos[i - 1] = 3;
  pos[0] = 8; pos[1] = 8; pos[2] = 8;           // 已出的三张（原站出牌 A: pos&=8）
  pos[15] = 9; pos[16] = 9; pos[17] = 9;   // 底牌归地主(玩家1)
  // 玩家1出过 [1,2,3]（顺子），玩家2过(0)，玩家3过(0) → playedCardList=[0,1,2,3,0,0]，轮玩家1(state=1)
  // canPlayAnyCards: 最后2个都是0 → true → lastCards=[]
  const st = E.expandState({ rule: 0, state: 1, landlordId: 1, cardPositionList: pos, playedCardList: [0, 1, 2, 3, 0, 0], v: 3 }, 3);
  eq('带位3标记的牌（底牌+已出的牌）', st.holeCardList, [1, 2, 3, 16, 17, 18]);
  eq('玩家1手牌(含底)', st.playerCardLists[1].length, 5 - 3 + 3);
  eq('连续过牌可自由出', st.canPlayAnyCards, true);
  eq('自由出时lastCards空', st.lastCards, []);
  // 再构造：只有玩家2过(0)，玩家1要压玩家3出的对
  const st2 = E.expandState({ rule: 0, state: 1, landlordId: 1, cardPositionList: pos, playedCardList: [0, 19, 20, 0], v: 3 }, 3);
  eq('lastCards 收集', st2.lastCards.sort((a, b) => a - b), [19, 20]);
  eq('不能自由出', st2.canPlayAnyCards, false);
  // 终局：state=9+0? 玩家2胜 = 10
  const st3 = E.expandState({ rule: 0, state: 10, landlordId: 1, cardPositionList: pos, playedCardList: [0], v: 3 }, 3);
  eq('终局判定', [st3.isFinish, st3.winner, st3.landlordWin], [true, 2, false]);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
