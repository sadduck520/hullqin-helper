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
