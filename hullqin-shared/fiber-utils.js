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
