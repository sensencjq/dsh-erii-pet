/**
 * 绘梨衣桌宠 · 桌面小窗渲染端。
 *
 * 与页内是同一份渲染核心；这里的 api 把请求转给 Electron 主进程，
 * 再由主进程经 stdio 交给宿主处理，全程不开端口、不访问网络。
 *
 * 本文件由 `scripts/build.mjs` 生成，勿手改产物。
 */
(function () {
  'use strict';

  var ERII_ART = __ART__;
  var ERII_ART_MODE = __ART_MODE__;
  var ERII_ART_ASPECT = __ART_ASPECT__;
  var SPRITE_COLS = __SPRITE_COLS__;
  var SPRITE_ROWS = __SPRITE_ROWS__;
  var SPRITE_WIDTH = __SPRITE_WIDTH__;
  var SPRITE_HEIGHT = __SPRITE_HEIGHT__;

  /*__PET_CORE__*/

  var bridge = window.eriiBridge;
  var pending = new Map();
  var nextId = 1;
  var lastState = null;
  var stateWaiters = [];

  function callHost(method, params) {
    return new Promise(function (resolve, reject) {
      if (!bridge) {
        reject(new Error('桌面桥不可用'));
        return;
      }
      var id = nextId += 1;
      pending.set(id, { resolve: resolve, reject: reject });
      bridge.send({ type: 'call', id: id, method: method, params: params || {} });
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('宿主响应超时'));
      }, 30000);
    });
  }

  function flushState() {
    var waiters = stateWaiters;
    stateWaiters = [];
    for (var i = 0; i < waiters.length; i += 1) waiters[i](lastState);
  }

  if (bridge) {
    bridge.onEvent(function (message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'result') {
        var entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error || '请求失败'));
        return;
      }
      if (message.type === 'state') {
        lastState = message;
        flushState();
      }
    });
    bridge.hello();
  }

  var api = {
    mode: 'desktop',
    init: function () {
      if (lastState) {
        return Promise.resolve({ config: lastState.config || {}, lines: lastState.lines || {} });
      }
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          resolve({ config: {}, lines: {} });
        }, 8000);
        stateWaiters.push(function (state) {
          clearTimeout(timer);
          resolve({ config: (state && state.config) || {}, lines: (state && state.lines) || {} });
        });
      });
    },
    call: function (method, params) {
      return callHost(method, params);
    },
    saveWebPosition: null,
    loadWebPosition: null,
    setInteractive: function (interactive) {
      if (bridge) bridge.interactive(interactive);
    },
    dragStart: function () {
      if (bridge) bridge.dragStart();
    },
    dragEnd: function () {
      if (bridge) bridge.dragEnd();
    },
    spriteUrl: './assets/spritesheet.webp',
    onEvent: function () {
      return function () {};
    },
  };

  var mount = document.getElementById('root');
  if (mount) {
    try {
      window.createEriPet({ mount: mount, api: api });
    } catch (error) {
      mount.textContent = '绘梨衣没有醒过来：' + (error && error.message ? error.message : String(error));
    }
  }
})();
