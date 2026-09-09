// E2E 验证 v3：提示=自动 一致性 + 合法性 + 升变校验 + 软锁优雅识别
(() => {
  window.__verify = { log: [], checked: 0, mismatch: 0, promos: 0, done: false, end: null };
  const A = self.__gjxAI;
  const EK = A.stateToFEN;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    const V = window.__verify;
    for (let i = 0; i < 30; i++) {
      // 等待：当前局面与缓存同步且缓存有结果（或检测到结束/软锁）
      let st = null, mv = null;
      for (let w = 0; w < 60; w++) {
        st = A.readState();
        if (!st) { await sleep(350); continue; }
        if (st.finish !== 0) { V.end = 'site-finish-' + st.finish; break; }
        const c = A.cache();
        if (c.result && c.key.indexOf(EK(st)) === 0) { mv = c.result; break; }
        // 软锁检测：面板显示将死提示且位置 8 秒未变
        const info = (document.querySelector('#gjxAI .info') || {}).textContent || '';
        if (info.indexOf('将死') >= 0 || info.indexOf('逼和') >= 0) {
          await sleep(2000);
          const st3 = A.readState();
          if (st3 && EK(st3) === EK(st) && !A.cache().result) { V.end = 'softlock-sitebug'; break; }
        }
        await sleep(300);
      }
      if (V.end) break;
      if (!st) { V.log.push({ i, err: '无法读取局面' }); break; }
      if (!mv) { V.log.push({ i, err: 'cache始终不同步', fen: EK(st).slice(0, 30) }); break; }
      const fen0 = EK(st);
      const fromPiece = st.pieces.find(p => p.pos === mv.from);
      // 等局面变化
      let st2 = st, w2 = 0;
      while (w2++ < 80) {
        await sleep(300);
        st2 = A.readState();
        if (st2 && EK(st2) !== fen0) break;
      }
      if (!st2 || EK(st2) === fen0) { V.log.push({ i, err: '未观察到走子' }); break; }
      const toPiece = st2.pieces.find(p => p.pos === mv.to);
      const fromEmpty = !st2.pieces.some(p => p.pos === mv.from);
      V.checked++;
      if (!fromPiece || !toPiece || !fromEmpty) {
        V.mismatch++;
        V.log.push({ i, err: '走子不符', mv: mv.from + '->' + mv.to });
        break;
      }
      // 升变校验：兵到底线后类型应改变（升后=site type 1）
      if (fromPiece.type === 5 && (mv.to < 8 || mv.to > 55)) {
        V.promos++;
        if (toPiece.type === 5) { V.mismatch++; V.log.push({ i, err: '升变未生效' }); break; }
        V.log.push({ i, ok: true, promo: '升变为' + ['王','后','车','象','马'][toPiece.type] });
      } else {
        V.log.push({ i, ok: true, mv: mv.from + '->' + mv.to });
      }
    }
    V.done = true;
  })();
})();
