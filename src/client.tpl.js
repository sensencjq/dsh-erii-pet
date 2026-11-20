/**
 * 绘梨衣桌宠 · 页内半侧（Client）。
 *
 * 挂一个 `shell.overlay` 条目：整层 click-through，只有立绘、气泡与面板接鼠标。
 * 渲染核心与桌面小窗共用同一份代码（构建时内联），这里只负责页内 transport：
 * 配置 / 台词 / 语音 / 聊天全走宿主挂在 `/dsh-erii-7351` 下的 HTTP 路由。
 *
 * 本文件由 `scripts/build.mjs` 从 `src/pet-core.js` + `src/client.tpl.js` 生成，勿手改产物。
 */
window.__ModuleLoader__.load({
  id: 'dsh-erii-pet',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var ERII_ART = __ART__;
    var ERII_ART_MODE = __ART_MODE__;
    var ERII_ART_ASPECT = __ART_ASPECT__;
    var SPRITE_COLS = __SPRITE_COLS__;
    var SPRITE_ROWS = __SPRITE_ROWS__;
    var SPRITE_WIDTH = __SPRITE_WIDTH__;
    var SPRITE_HEIGHT = __SPRITE_HEIGHT__;
    var ROUTE_SEGMENT = '__ROUTE__';

    /*__PET_CORE__*/

    /** 文档挂载前缀（反代把 UI 挂在子路径下时，路由也要带这一截）。 */
    function routeBase() {
      try {
        var base = new URL('.', document.baseURI).pathname.replace(/\/+$/, '');
        return base + ROUTE_SEGMENT;
      } catch (error) {
        return ROUTE_SEGMENT;
      }
    }

    /** ArrayBuffer → base64（分块，避免大数组一次展开爆栈）。 */
    function toBase64(buffer) {
      var bytes = new Uint8Array(buffer);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    var POSITION_KEY = 'erii.web.position';

    function createWebApi() {
      var base = routeBase();
      return {
        mode: 'web',
        init: function () {
          return Promise.all([
            fetch(base + '/config', { credentials: 'same-origin' }).then(function (response) {
              return response.json();
            }),
            fetch(base + '/lines', { credentials: 'same-origin' }).then(function (response) {
              return response.json();
            }),
          ]).then(function (results) {
            var configPayload = results[0] || {};
            var linesPayload = results[1] || {};
            return {
              config: configPayload.config || {},
              lines: { userName: linesPayload.userName || 'Sakura', sets: linesPayload.sets || {} },
            };
          });
        },
        call: function (method, params) {
          if (method === 'voice') {
            return fetch(base + '/voice', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(params || {}),
            }).then(function (response) {
              if (!response.ok) throw new Error('voice http ' + response.status);
              return response.arrayBuffer().then(function (buffer) {
                return { base64: toBase64(buffer), mime: 'audio/mpeg' };
              });
            });
          }
          if (method === 'config') {
            return fetch(base + '/config', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch: params && params.patch }),
            }).then(function (response) {
              return response.json();
            });
          }
          var path = method === 'chat' ? '/chat' : method === 'whisper' ? '/whisper' : null;
          if (!path) return Promise.reject(new Error('unknown method ' + method));
          return fetch(base + path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params || {}),
          }).then(function (response) {
            return response.json();
          });
        },
        saveWebPosition: function (pos) {
          try {
            localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
          } catch (error) {
            /* 隐私模式写不进去也不影响当前会话 */
          }
        },
        loadWebPosition: function () {
          try {
            var raw = localStorage.getItem(POSITION_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) ? parsed : null;
          } catch (error) {
            return null;
          }
        },
        setInteractive: function () {},
        dragStart: function () {},
        dragEnd: function () {},
        spriteUrl: base + '/sprite',
        onEvent: function () {
          return function () {};
        },
      };
    }

    function PetOverlay() {
      var hostRef = React.useRef(null);
      React.useEffect(function () {
        if (!hostRef.current) return undefined;
        var instance = window.createEriPet({ mount: hostRef.current, api: createWebApi() });
        return function () {
          instance.destroy();
        };
      }, []);
      return h('div', { ref: hostRef, style: { display: 'contents' } });
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'erii-pet', order: 1180 },
            PetOverlay,
          );
        });
      },
    };
  },
});
