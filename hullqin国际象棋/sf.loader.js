/**
 * Stockfish Worker 加载器（路线 A）
 * 从 jsdelivr CDN 拉取 stockfish@10.0.2（wasm 版），打补丁后以 Blob Worker 运行
 * - 官方胶水只认 STOCKFISH(wasmPath) 参数，blob worker 拿不到 hash，
 *   所以把 wasm 做成 blob URL、替换自动初始化调用注入进去
 * - 暴露 UCI 接口：send(cmd) / onLine(fn) / quit()
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SFLoader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/';

  // 带进度的 fetch
  function fetchProg(url, onProg) {
    return fetch(url).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const len = +res.headers.get('content-length') || 0;
      if (!res.body || !len) return res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks = [];
      let recv = 0;
      function pump() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            const out = new Uint8Array(recv);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            return out.buffer;
          }
          recv += value.length;
          chunks.push(value);
          if (onProg) onProg(recv / len);
          return pump();
        });
      }
      return pump();
    });
  }

  function bytesToB64(buf) {
    const u8 = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /**
   * 加载引擎，resolve 出 {send, onLine, destroy}
   * onProgress: 0~1 的下载进度回调
   */
  function load(onProgress) {
    return new Promise((resolve, reject) => {
      let glueP = fetchProg(CDN + 'stockfish.js', onProgress ? p => onProgress(p * 0.12) : null)
        .then(b => new TextDecoder().decode(b));
      let wasmP = fetchProg(CDN + 'stockfish.wasm', onProgress ? p => onProgress(0.12 + p * 0.88) : null);
      Promise.all([glueP, wasmP]).then(([glue, wasmBuf]) => {
        try {
          const TARGET = 'stockfish=STOCKFISH()';
          if (!glue.includes(TARGET)) throw new Error('胶水代码格式已变化，无法注入 wasm');
          const wasmUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));
          const patched = glue.replace(TARGET, 'stockfish=STOCKFISH("' + wasmUrl + '")');
          const worker = new Worker(URL.createObjectURL(new Blob([patched], { type: 'application/javascript' })));
          const api = {
            _listeners: [],
            send(cmd) { worker.postMessage(cmd); },
            onLine(fn) { this._listeners.push(fn); },
            destroy() { try { worker.terminate(); } catch (e) { } },
          };
          worker.onmessage = e => {
            const text = '' + e.data;
            for (const line of text.split('\n')) {
              const t = line.trim();
              if (t) for (const fn of api._listeners) fn(t);
            }
          };
          worker.onerror = e => reject(new Error('SF worker: ' + (e.message || '未知错误')));
          let done = false;
          api.onLine(line => {
            if (!done && line === 'uciok') { done = true; resolve(api); }
          });
          setTimeout(() => { if (!done) { done = true; resolve(api); } }, 12000); // 兜底
          worker.postMessage('uci');
        } catch (err) { reject(err); }
      }).catch(reject);
    });
  }

  return { load };
});
