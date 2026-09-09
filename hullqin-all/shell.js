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
