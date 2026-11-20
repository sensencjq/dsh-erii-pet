/**
 * 绘梨衣桌宠 · 渲染核心（页内与桌面共用的同一份）。
 *
 * 这个文件不 import 任何东西：构建脚本会把立绘 SVG 与 transport 一起内联进
 * `client.js` 与 `helper/renderer.js`，两处跑的是同一份行为代码。
 *
 * 对外只暴露 `window.createEriPet(options)`；options.api 是宿主适配层
 * （页内走 HTTP，桌面走 stdio 桥），核心只认这几个方法：
 *   mode: 'web' | 'desktop'
 *   init() -> Promise<{config, lines}>
 *   call(method, params) -> Promise<any>
 *   saveWebPosition(pos) / loadWebPosition()
 *   setInteractive(bool) / dragStart() / dragEnd()
 *   onEvent(cb) -> unsubscribe
 *
 * @module dsh-erii-pet/pet-core
 */
(function (global) {
  'use strict';

  /** 立绘由构建脚本注入；直接打开源码预览时为空。 */
  var ART = typeof ERII_ART === 'string' ? ERII_ART : '';
  /** 立绘形态：'sprite' = 动画图集，'image' = 3D 渲染图，'svg' = 矢量立绘。 */
  var ART_MODE = typeof ERII_ART_MODE === 'string' ? ERII_ART_MODE : 'svg';
  /** 立绘高 / 宽（用于算宠物占位）。 */
  var ART_ASPECT =
    typeof ERII_ART_ASPECT === 'number' && ERII_ART_ASPECT > 0.2 && ERII_ART_ASPECT < 5
      ? ERII_ART_ASPECT
      : 560 / 420;
  /** 图集几何：8 列 × 11 行、单帧 192×208（由构建脚本注入）。 */
  var SPRITE = {
    cols: typeof SPRITE_COLS === 'number' ? SPRITE_COLS : 8,
    rows: typeof SPRITE_ROWS === 'number' ? SPRITE_ROWS : 11,
    width: typeof SPRITE_WIDTH === 'number' ? SPRITE_WIDTH : 192,
    height: typeof SPRITE_HEIGHT === 'number' ? SPRITE_HEIGHT : 208,
  };

  /** 图集动画表：行号来自绘梨衣宠物包（Codex Pet / Petdex 社区素材）。 */
  var SPRITE_ROWS_MAP = {
    idle: { row: 0, frames: 7, fps: 6, loop: true },
    walkRight: { row: 1, frames: 8, fps: 10, loop: true },
    walkLeft: { row: 2, frames: 8, fps: 10, loop: true },
    wave: { row: 3, frames: 4, fps: 7, loop: false },
    emote: { row: 4, frames: 5, fps: 8, loop: false },
    sleep: { row: 5, frames: 8, fps: 3, loop: true },
    think: { row: 7, frames: 6, fps: 5, loop: true },
  };

  /** 可选的音色（展示用；真正的白名单在宿主）。 */
  var VOICES = [
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 清亮少女' },
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔邻家' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 软糯东北腔' },
    { id: 'ja-JP-NanamiNeural', name: '七海 · 日语少女' },
    { id: 'ja-JP-AoiNeural', name: '葵 · 日语清冷' },
  ];

  /** 台词的兜底：宿主取不到台词包时也有话说。 */
  var FALLBACK_LINES = {
    greeting: ['……Sakura。', '你来了。'],
    click: ['……嗯？', '绘梨衣，在。'],
    idleWhisper: ['好安静。', '冰淇淋……'],
    drag: ['去哪里……', '手，别松开。'],
    headpat: ['……嗯。', '可以，再摸一下。'],
    icecream: ['冰淇淋。', '……甜的。'],
    sleep: ['困了……', '晚安……'],
    wake: ['……醒了。', '还在吗。'],
    chatFail: ['……听不懂。', '绘梨衣，不明白。'],
  };

  var CSS = [
    '.erii-stage{position:fixed;inset:0;z-index:2147482000;pointer-events:none;overflow:hidden;',
    '--erii-w:210px;--erii-red:#c0243a;--erii-deep:#6b1526;--erii-ink:#4a2028;--erii-paper:#fffaf6;}',
    '.erii-stage[data-mode="desktop"]{position:absolute;}',
    '.erii-stage.is-hidden{display:none;}',
    '.erii-pet{position:absolute;left:0;top:0;width:var(--erii-w);will-change:transform;pointer-events:none;',
    'transition:transform .18s ease-out;touch-action:none;}',
    '.erii-pet.is-walking{transition:transform 2.2s cubic-bezier(.4,0,.3,1);}',
    '.erii-pet.is-settling{transition:transform .55s cubic-bezier(.34,1.16,.64,1);}',
    '.erii-figure{position:relative;width:100%;height:100%;pointer-events:auto;cursor:grab;',
    'filter:drop-shadow(0 10px 14px rgba(40,8,16,.28));transform-origin:50% 92%;',
    'animation:erii-breathe 4.2s ease-in-out infinite;}',
    '.erii-art-wrap{width:100%;height:100%;}',
    '.erii-sprite{width:100%;height:100%;display:block;pointer-events:none;}',
    '.erii-sprite-zzz{right:12%!important;top:8%!important;}',
    '.erii-pet.is-dragging .erii-figure{cursor:grabbing;animation:none;transform:rotate(-5deg) scale(1.02);}',
    '.erii-pet.is-walking .erii-figure{animation:erii-step .34s ease-in-out infinite;}',
    '.erii-pet.is-happy .erii-figure{animation:erii-hop .5s ease-out 2;}',
    '.erii-pet.is-eat .erii-figure{animation:erii-chew .8s ease-in-out infinite;}',
    '.erii-pet.is-sleep .erii-figure{animation:erii-breathe 6s ease-in-out infinite;}',
    '.erii-figure svg.erii-art{display:block;width:100%;height:auto;overflow:visible;user-select:none;-webkit-user-drag:none;}',
    '.erii-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;}',
    '.erii-fx .fx-blush{opacity:0;transition:opacity .35s;}',
    '.erii-pet.is-shy .fx-blush,.erii-pet.is-happy .fx-blush{opacity:.85;}',
    '.erii-fx .fx-zzz{opacity:0;}',
    '.erii-pet.is-sleep .fx-zzz{opacity:1;animation:erii-zzz 3.2s ease-in-out infinite;}',
    '.erii-fx .fx-tear{opacity:0;}',
    '.erii-pet.is-sad .fx-tear{opacity:.9;animation:erii-tear 2.4s ease-in infinite;}',
    '.erii-fx .fx-heart{opacity:0;}',
    '.erii-pet.is-love .fx-heart{opacity:1;animation:erii-float 2.6s ease-in-out infinite;}',
    '.erii-fx .fx-spark{opacity:0;}',
    '.erii-pet.is-sparkle .fx-spark{opacity:1;animation:erii-spark 1.4s ease-in-out infinite;}',
    '.erii-art-img{display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none;}',
    '.erii-fx .erii-blush{position:absolute;width:15%;height:7%;border-radius:50%;',
    'background:radial-gradient(ellipse at center,rgba(233,115,138,.6),rgba(233,115,138,0) 70%);',
    'opacity:0;transition:opacity .35s;filter:blur(2px);}',
    '.erii-blush-a{left:25%;top:30%;}',
    '.erii-blush-b{right:25%;top:30%;}',
    '.erii-pet.is-shy .erii-blush,.erii-pet.is-happy .erii-blush,.erii-pet.is-love .erii-blush{opacity:1;}',
    '.erii-fx .erii-zzz{position:absolute;right:10%;top:9%;font:700 19px/1 "KaiTi","STKaiti",serif;color:#fff;',
    'text-shadow:0 2px 8px rgba(40,8,16,.55);opacity:0;letter-spacing:2px;}',
    '.erii-pet.is-sleep .erii-fx .erii-zzz{opacity:1;animation:erii-zzz 3.2s ease-in-out infinite;}',
    '.erii-figure .erii-icecream{opacity:0;transition:opacity .25s;}',
    '.erii-pet.is-eat .erii-figure .erii-icecream{opacity:1;}',
    '.erii-shadow{position:absolute;left:12%;bottom:-6px;width:76%;height:14px;border-radius:50%;',
    'background:radial-gradient(ellipse at center,rgba(40,8,16,.30),rgba(40,8,16,0) 70%);filter:blur(2px);}',
    '.erii-bubble{position:absolute;left:50%;bottom:calc(100% - 4px);transform:translate(-50%,8px) scale(.96);',
    'width:max-content;box-sizing:border-box;max-width:250px;min-width:76px;padding:9px 13px 10px;border-radius:14px;',
    'background:var(--erii-paper);color:var(--erii-ink);font-family:"KaiTi","STKaiti","Microsoft YaHei",serif;',
    'font-size:15px;line-height:1.55;letter-spacing:.5px;text-align:center;',
    'border:1px solid rgba(150,30,55,.22);box-shadow:0 8px 24px rgba(40,8,16,.18);',
    'opacity:0;pointer-events:none;transition:opacity .22s,transform .22s;white-space:pre-wrap;}',
    '.erii-bubble:after{content:"";position:absolute;left:50%;bottom:-6px;width:10px;height:10px;',
    'transform:translateX(-50%) rotate(45deg);background:var(--erii-paper);border-right:1px solid rgba(150,30,55,.22);',
    'border-bottom:1px solid rgba(150,30,55,.22);}',
    '.erii-bubble.is-show{opacity:1;transform:translate(-50%,0) scale(1);}',
    '.erii-bubble.is-sleep{opacity:.82;}',
    '.erii-menu,.erii-panel{position:absolute;pointer-events:auto;box-sizing:border-box;',
    'font-family:"KaiTi","STKaiti","Microsoft YaHei",serif;color:var(--erii-ink);',
    'background:rgba(255,250,246,.97);border:1px solid rgba(150,30,55,.22);border-radius:14px;',
    'box-shadow:0 18px 48px rgba(30,6,12,.28);backdrop-filter:blur(6px);}',
    '.erii-menu{min-width:150px;padding:6px;z-index:30;}',
    '.erii-menu[hidden],.erii-panel[hidden],.erii-bubble[hidden]{display:none;}',
    '.erii-menu button{display:block;width:100%;padding:7px 10px;border:0;border-radius:9px;background:transparent;',
    'color:inherit;font:inherit;font-size:14px;text-align:left;cursor:pointer;}',
    '.erii-menu button:hover{background:rgba(192,36,58,.10);}',
    '.erii-menu .sep{height:1px;margin:5px 8px;background:rgba(150,30,55,.14);}',
    '.erii-menu .dim{opacity:.55;}',
    '.erii-panel{width:300px;z-index:40;display:flex;flex-direction:column;overflow:hidden;}',
    '.erii-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;',
    'border-bottom:1px solid rgba(150,30,55,.14);font-size:15px;letter-spacing:1px;color:var(--erii-deep);}',
    '.erii-panel-head .x{border:0;background:transparent;font-size:16px;color:inherit;cursor:pointer;opacity:.6;}',
    '.erii-chat-list{flex:1;min-height:150px;max-height:260px;overflow:auto;padding:10px 12px;display:flex;',
    'flex-direction:column;gap:8px;font-size:14px;line-height:1.5;}',
    '.erii-chat-row{max-width:84%;padding:6px 10px;border-radius:11px;white-space:pre-wrap;word-break:break-word;}',
    '.erii-chat-row.user{align-self:flex-end;background:rgba(192,36,58,.12);}',
    '.erii-chat-row.her{align-self:flex-start;background:rgba(255,255,255,.92);border:1px solid rgba(150,30,55,.16);}',
    '.erii-chat-row.sys{align-self:center;opacity:.55;font-size:12px;}',
    '.erii-chat-form{display:flex;gap:6px;padding:8px 10px;border-top:1px solid rgba(150,30,55,.14);}',
    '.erii-chat-form input{flex:1;min-width:0;border:1px solid rgba(150,30,55,.25);border-radius:9px;',
    'background:#fff;padding:6px 9px;font:inherit;font-size:14px;color:inherit;outline:none;}',
    '.erii-chat-form input:focus{border-color:rgba(192,36,58,.6);}',
    '.erii-chat-form button{border:0;border-radius:9px;background:var(--erii-red);color:#fff;padding:6px 12px;',
    'font:inherit;font-size:14px;cursor:pointer;}',
    '.erii-settings-body{padding:10px 12px;display:grid;gap:9px;font-size:13px;overflow:auto;max-height:340px;}',
    '.erii-settings-body label{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    '.erii-settings-body input[type=range]{width:130px;}',
    '.erii-settings-body input[type=text],.erii-settings-body select{border:1px solid rgba(150,30,55,.25);',
    'border-radius:8px;background:#fff;padding:4px 7px;font:inherit;font-size:13px;color:inherit;max-width:160px;}',
    '.erii-settings-body .hint{opacity:.55;font-size:12px;line-height:1.5;}',
    '.erii-settings-foot{padding:8px 12px 12px;display:flex;justify-content:flex-end;gap:8px;}',
    '.erii-btn{border:0;border-radius:9px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;',
    'background:rgba(192,36,58,.12);color:var(--erii-deep);}',
    '.erii-btn.primary{background:var(--erii-red);color:#fff;}',
    '.erii-pet.is-flip .erii-figure{transform:scaleX(-1);}',
    '.erii-pet.is-look-left .erii-figure{transform:translateX(-4px) rotate(-1.5deg);}',
    '.erii-pet.is-look-right .erii-figure{transform:translateX(4px) rotate(1.5deg);}',
    '.erii-pet.is-stretch .erii-figure{transform:scale(1.03,.98) translateY(-2px);}',
    '.erii-pet .erii-heart-note{position:absolute;left:50%;top:-10px;transform:translateX(-50%);font-size:18px;color:#d43a5a;opacity:0;}',
    '.erii-pet.is-love .erii-heart-note{animation:erii-float 2.6s ease-in-out infinite;opacity:1;}',
    '@keyframes erii-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,.988)}}',
    '@keyframes erii-step{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
    '@keyframes erii-hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-12px)}}',
    '@keyframes erii-chew{0%,100%{transform:scale(1,1)}50%{transform:scale(.995,1.01) translateY(-1px)}}',
    '@keyframes erii-zzz{0%{opacity:0;transform:translateY(0)}30%{opacity:.9}100%{opacity:0;transform:translateY(-14px)}}',
    '@keyframes erii-tear{0%{opacity:0;transform:translateY(0)}30%{opacity:.9}100%{opacity:0;transform:translateY(16px)}}',
    '@keyframes erii-spark{0%,100%{opacity:0;transform:scale(.7)}50%{opacity:1;transform:scale(1.1)}}',
    '@keyframes erii-float{0%,100%{transform:translateY(0);opacity:.9}50%{transform:translateY(-8px);opacity:1}}',
    '.erii-dock{position:fixed;right:16px;bottom:16px;z-index:2147482001;pointer-events:auto;',
    'border:1px solid rgba(150,30,55,.30);border-radius:999px;padding:6px 14px;',
    'background:rgba(255,250,246,.96);color:var(--erii-deep);font:14px "KaiTi","STKaiti",serif;',
    'box-shadow:0 8px 24px rgba(40,8,16,.22);cursor:pointer;letter-spacing:1px;}',
    '.erii-dock[hidden]{display:none;}',
    '.erii-stage[data-mode="desktop"] ~ .erii-dock{position:absolute;}',
    '@media (prefers-reduced-motion: reduce){.erii-figure,.erii-pet *{animation:none!important;transition:none!important}}',
  ].join('');

  /** 小块 DOM 构造器。 */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 从事件里取坐标（兼容 touch）。 */
  function pointOf(event) {
    if (event.touches && event.touches[0]) return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    if (event.changedTouches && event.changedTouches[0]) {
      return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
    }
    return { x: event.clientX, y: event.clientY };
  }

  /** 随机取一条。 */
  function pick(list) {
    if (!Array.isArray(list) || list.length === 0) return '……';
    return list[Math.floor(Math.random() * list.length)];
  }

  /** 限制在区间内。 */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * 创建宠物实例。
   * @param {{mount: HTMLElement, api: any}} options
   */
  function createEriPet(options) {
    var api = options.api;
    var mode = api.mode === 'desktop' ? 'desktop' : 'web';
    var mount = options.mount;

    var state = {
      config: null,
      lines: FALLBACK_LINES,
      userName: 'Sakura',
      ready: false,
      destroyed: false,
      sleeping: false,
      busy: false,
      hidden: false,
      pos: { x: null, y: null },
      flip: false,
      lastInteractionAt: Date.now(),
      speakToken: 0,
      audio: null,
      bubbleTimer: null,
      whisperTimer: null,
      idleTimer: null,
      sleepTimer: null,
      chatOpened: false,
      chatBusy: false,
    };

    // ── DOM ─────────────────────────────────────────────────────────────────
    var stage = el('div', 'erii-stage');
    stage.setAttribute('data-mode', mode);
    var style = document.createElement('style');
    style.textContent = CSS;

    var pet = el('div', 'erii-pet');
    var bubble = el('div', 'erii-bubble');
    bubble.hidden = true;
    var figure = el('div', 'erii-figure');
    var heartNote = el('div', 'erii-heart-note', '♡');
    var shadow = el('div', 'erii-shadow');
    var fxLayer = document.createElement('div');
    fxLayer.className = 'erii-fx';
    if (ART_MODE === 'sprite') {
      // 图集本身带表情帧，不再叠 SVG 五官特效；只留一个睡觉的 Z。
      fxLayer.innerHTML = '<div class="erii-zzz erii-sprite-zzz">z z</div>';
    } else if (ART_MODE === 'image') {
      fxLayer.innerHTML = RASTER_FX_HTML;
    } else {
      fxLayer.innerHTML = FX_SVG;
    }
    var artLayer = document.createElement('div');
    artLayer.className = 'erii-art-wrap';
    var spriteEl = null;
    var spriteImage = null;
    var spriteCtx = null;
    if (ART_MODE === 'sprite') {
      spriteEl = document.createElement('canvas');
      spriteEl.className = 'erii-sprite';
      spriteCtx = spriteEl.getContext('2d');
      spriteImage = new Image();
      if (typeof api.spriteUrl === 'string' && api.spriteUrl !== '') {
        spriteImage.src = api.spriteUrl;
      }
      spriteImage.onload = function () {
        spriteLayout();
      };
      artLayer.appendChild(spriteEl);
    } else if (ART_MODE === 'image') {
      var artImg = document.createElement('img');
      artImg.className = 'erii-art erii-art-img';
      artImg.src = ART;
      artImg.draggable = false;
      artImg.alt = '';
      artLayer.appendChild(artImg);
    } else {
      artLayer.innerHTML = ART;
      var artSvg = artLayer.querySelector('svg');
      if (artSvg) {
        artSvg.classList.add('erii-art');
        artSvg.setAttribute('aria-hidden', 'true');
      }
    }
    figure.appendChild(artLayer);
    figure.appendChild(fxLayer);
    // 冰淇淋是叠加在立绘上的小道具：图集模式自带动作，不再叠。
    if (ART_MODE !== 'sprite') {
      var icecream = document.createElement('div');
      icecream.className = 'erii-icecream';
      icecream.innerHTML = ICECREAM_SVG;
      figure.appendChild(icecream);
    }

    pet.appendChild(bubble);
    pet.appendChild(heartNote);
    pet.appendChild(figure);
    pet.appendChild(shadow);
    stage.appendChild(pet);

    // 右键菜单
    var menu = el('div', 'erii-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    var menuItems = [
      { id: 'pat', label: '摸摸头' },
      { id: 'icecream', label: '吃个冰淇淋' },
      { id: 'talk', label: '和绘梨衣说话' },
      { id: 'sleep', label: '让她睡一会儿' },
      { id: 'sep' },
      { id: 'voice', label: '声音：开' },
      { id: 'desktop', label: '到桌面上去' },
      { id: 'settings', label: '设定…' },
      { id: 'hide', label: '先躲起来' },
    ];
    var menuButtons = {};
    for (var i = 0; i < menuItems.length; i += 1) {
      var item = menuItems[i];
      if (item.id === 'sep') {
        menu.appendChild(el('div', 'sep'));
        continue;
      }
      var button = el('button', '', item.label);
      button.type = 'button';
      button.setAttribute('data-act', item.id);
      menu.appendChild(button);
      menuButtons[item.id] = button;
    }
    stage.appendChild(menu);

    // 聊天面板
    var chat = el('div', 'erii-panel erii-chat');
    chat.hidden = true;
    var chatHead = el('div', 'erii-panel-head');
    chatHead.appendChild(el('span', '', '绘梨衣'));
    var chatClose = el('button', 'x', '×');
    chatClose.type = 'button';
    chatHead.appendChild(chatClose);
    var chatList = el('div', 'erii-chat-list');
    var chatForm = el('form', 'erii-chat-form');
    var chatInput = el('input');
    chatInput.type = 'text';
    chatInput.placeholder = '对绘梨衣说点什么…';
    chatInput.autocomplete = 'off';
    chatInput.maxLength = 200;
    var chatSend = el('button', '', '说');
    chatSend.type = 'submit';
    chatForm.appendChild(chatInput);
    chatForm.appendChild(chatSend);
    chat.appendChild(chatHead);
    chat.appendChild(chatList);
    chat.appendChild(chatForm);
    stage.appendChild(chat);

    // 设置面板
    var settings = el('div', 'erii-panel erii-settings');
    settings.hidden = true;
    var settingsHead = el('div', 'erii-panel-head');
    settingsHead.appendChild(el('span', '', '绘梨衣 · 设定'));
    var settingsClose = el('button', 'x', '×');
    settingsClose.type = 'button';
    settingsHead.appendChild(settingsClose);
    var settingsBody = el('div', 'erii-settings-body');
    settings.appendChild(settingsHead);
    settings.appendChild(settingsBody);
    stage.appendChild(settings);

    mount.appendChild(style);
    mount.appendChild(stage);

    // 「先躲起来」之后找回她的入口：一颗小胶囊，不挡住宠物本体的位置。
    var dock = el('button', 'erii-dock', '绘梨衣');
    dock.type = 'button';
    dock.title = '把绘梨衣叫回来';
    dock.hidden = true;
    dock.addEventListener('click', function () {
      restorePet();
    });
    mount.appendChild(dock);

    // ── 基础状态 ────────────────────────────────────────────────────────────
    function setExpression(name, duration) {
      if (ART_MODE === 'sprite') {
        if (name === 'sleep') playSprite('sleep');
        else if (name === 'shy' || name === 'happy' || name === 'love' || name === 'sparkle') {
          playSprite('emote', { onDone: spriteIdle });
        }
        // 图集自带表情：仍然保留 class，用给 Z 与睡姿样式。
        var spriteNames = ['is-shy', 'is-happy', 'is-eat', 'is-sad', 'is-love', 'is-sparkle', 'is-sleep'];
        for (var s = 0; s < spriteNames.length; s += 1) pet.classList.remove(spriteNames[s]);
        if (name) pet.classList.add('is-' + name);
        if (duration) {
          setTimeout(function () {
            if (!state.destroyed) pet.classList.remove('is-' + name);
          }, duration);
        }
        return;
      }
      var names = ['is-shy', 'is-happy', 'is-eat', 'is-sad', 'is-love', 'is-sparkle', 'is-sleep'];
      for (var k = 0; k < names.length; k += 1) pet.classList.remove(names[k]);
      if (name) pet.classList.add('is-' + name);
      if (duration) {
        setTimeout(function () {
          if (!state.destroyed) pet.classList.remove('is-' + name);
        }, duration);
      }
    }

    function clearBubble() {
      if (state.bubbleTimer) {
        clearTimeout(state.bubbleTimer);
        state.bubbleTimer = null;
      }
      bubble.classList.remove('is-show');
      setTimeout(function () {
        if (!state.destroyed && !bubble.classList.contains('is-show')) bubble.hidden = true;
      }, 260);
    }

    function showBubble(text, options) {
      if (!text || state.hidden) return;
      var opts = options || {};
      bubble.hidden = false;
      bubble.textContent = text;
      bubble.classList.toggle('is-sleep', Boolean(opts.sleep));
      bubble.classList.add('is-show');
      if (state.bubbleTimer) clearTimeout(state.bubbleTimer);
      var hold = opts.hold || clamp(2200 + text.length * 140, 2600, 8000);
      state.bubbleTimer = setTimeout(function () {
        bubble.classList.remove('is-show');
        state.bubbleTimer = setTimeout(function () {
          if (!state.destroyed) bubble.hidden = true;
        }, 260);
      }, hold);
    }

    /** 播放一段语音（宿主合成，带缓存）；失败就安静地只留气泡。 */
    function speak(text) {
      if (!state.config || !state.config.voiceEnabled || !text || state.hidden) return;
      var token = (state.speakToken += 1);
      api
        .call('voice', { text: text })
        .then(function (value) {
          if (state.destroyed || token !== state.speakToken) return;
          var base64 = value && value.base64;
          if (!base64) return;
          try {
            if (state.audio) state.audio.pause();
            var audio = new Audio('data:' + (value.mime || 'audio/mpeg') + ';base64,' + base64);
            audio.volume = typeof state.config.volume === 'number' ? state.config.volume : 0.9;
            state.audio = audio;
            audio.play().catch(function () {});
          } catch (error) {
            /* 播放失败不影响气泡 */
          }
        })
        .catch(function () {});
    }

    /** 一次「说话」：气泡 + 可选语音。 */
    function say(text, options) {
      var opts = options || {};
      showBubble(text, opts);
      if (opts.voice !== false) speak(text);
    }

    function sayLine(key, options) {
      var text = pick(state.lines[key]);
      say(text, options);
      return text;
    }

    // ── 位置与尺寸 ──────────────────────────────────────────────────────────
    function petSize() {
      var width = state.config && state.config.size ? state.config.size : 210;
      return { width: width, height: Math.round(width * ART_ASPECT) };
    }

    function defaultPos() {
      var size = petSize();
      if (mode === 'desktop') {
        // 小窗本身贴在屏幕右下角；宠物放在窗内的底部中间，上方留给气泡与面板。
        return {
          x: Math.max(8, Math.round((window.innerWidth - size.width) / 2)),
          y: Math.max(8, window.innerHeight - size.height - 10),
        };
      }
      return {
        x: Math.max(8, window.innerWidth - size.width - 22),
        y: Math.max(8, window.innerHeight - size.height - 10),
      };
    }

    function normalizedPos(pos) {
      var size = petSize();
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return defaultPos();
      return {
        x: clamp(pos.x, 0, Math.max(0, window.innerWidth - size.width)),
        y: clamp(pos.y, 0, Math.max(0, window.innerHeight - size.height)),
      };
    }

    function applyPos(pos) {
      state.pos = pos;
      var size = petSize();
      pet.style.width = size.width + 'px';
      pet.style.height = size.height + 'px';
      pet.style.transform = 'translate3d(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px,0)';
      spriteLayout();
      layoutPanels();
    }

    // ── 图集动画（'sprite' 模式）────────────────────────────────────────────
    var spriteTimer = null;
    var spriteAnim = { row: 0, frame: 0, frames: 11, loop: true, onDone: null };

    /** 按当前尺寸重排图集：canvas 尺寸跟着宠物走，按设备像素比取整避免发糊。 */
    function spriteLayout() {
      if (!spriteEl) return;
      var size = petSize();
      var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      spriteEl.width = Math.round(size.width * dpr);
      spriteEl.height = Math.round(size.height * dpr);
      spriteEl.style.width = size.width + 'px';
      spriteEl.style.height = size.height + 'px';
      spriteDraw();
    }

    /** 把 canvas 切到当前帧。 */
    function spriteDraw() {
      if (!spriteEl || !spriteCtx) return;
      var size = petSize();
      var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      spriteCtx.clearRect(0, 0, spriteEl.width, spriteEl.height);
      if (!spriteImage || !spriteImage.complete || spriteImage.naturalWidth === 0) return;
      var frameW = spriteImage.naturalWidth / SPRITE.cols;
      var frameH = spriteImage.naturalHeight / SPRITE.rows;
      spriteCtx.drawImage(
        spriteImage,
        spriteAnim.frame * frameW,
        spriteAnim.row * frameH,
        frameW,
        frameH,
        0,
        0,
        Math.round(size.width * dpr),
        Math.round(size.height * dpr),
      );
    }

    /**
     * 播一段图集动画。
     * @param {string} key - SPRITE_ROWS_MAP 里的键
     * @param {{frames?: number, fps?: number, loop?: boolean, onDone?: () => void}} [options]
     */
    function playSprite(key, options) {
      if (!spriteEl) return;
      var spec = SPRITE_ROWS_MAP[key] || SPRITE_ROWS_MAP.idle;
      var opts = options || {};
      var frames = typeof opts.frames === 'number' ? opts.frames : spec.frames;
      var fps = typeof opts.fps === 'number' ? opts.fps : spec.fps;
      var loop = typeof opts.loop === 'boolean' ? opts.loop : spec.loop;
      if (spriteTimer) {
        clearInterval(spriteTimer);
        spriteTimer = null;
      }
      spriteAnim = { row: spec.row, frame: 0, frames: frames, loop: loop, onDone: opts.onDone || null };
      spriteLayout();
      if (frames <= 1 || fps <= 0) return;
      spriteTimer = setInterval(function () {
        spriteAnim.frame += 1;
        if (spriteAnim.frame >= spriteAnim.frames) {
          if (spriteAnim.loop) {
            spriteAnim.frame = 0;
          } else {
            clearInterval(spriteTimer);
            spriteTimer = null;
            var done = spriteAnim.onDone;
            if (done) done();
            return;
          }
        }
        spriteDraw();
      }, 1000 / fps);
    }

    /** 回到待机（图集模式）。 */
    function spriteIdle() {
      if (ART_MODE === 'sprite') playSprite('idle');
    }

    /** 面板跟随宠物：菜单/聊天窗贴在宠物上方，并夹在视口内。 */
    function layoutPanels() {
      if (!state.pos) return;
      var size = petSize();
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var petLeft = state.pos.x;
      var petTop = state.pos.y;
      // 菜单
      var mw = 158;
      var mh = menu.offsetHeight || 300;
      menu.style.left = clamp(petLeft + size.width - mw, 6, vw - mw - 6) + 'px';
      menu.style.top = clamp(petTop + 10, 6, vh - mh - 6) + 'px';
      // 聊天 / 设置
      var pw = 300;
      var ph = chat.hidden ? 0 : 340;
      var left = clamp(petLeft + size.width / 2 - pw / 2, 6, vw - pw - 6);
      var top = clamp(petTop - ph - 8, 6, vh - ph - 6);
      chat.style.left = left + 'px';
      chat.style.top = top + 'px';
      ph = settings.hidden ? 0 : 400;
      left = clamp(petLeft + size.width / 2 - pw / 2, 6, vw - pw - 6);
      top = clamp(petTop - ph - 8, 6, vh - ph - 6);
      settings.style.left = left + 'px';
      settings.style.top = top + 'px';
    }

    // ── 行为 ────────────────────────────────────────────────────────────────
    function clearActionTimers() {
      if (state.whisperTimer) clearTimeout(state.whisperTimer);
      if (state.idleTimer) clearInterval(state.idleTimer);
      if (state.sleepTimer) clearTimeout(state.sleepTimer);
      state.whisperTimer = null;
      state.idleTimer = null;
      state.sleepTimer = null;
    }

    function wake() {
      if (!state.sleeping) return;
      state.sleeping = false;
      pet.classList.remove('is-sleep');
      spriteIdle();
      sayLine('wake', { hold: 3200 });
      scheduleWhisper();
      scheduleSleep();
    }

    function goSleep(silent) {
      if (state.sleeping) return;
      state.sleeping = true;
      closeMenu();
      closeChat();
      setExpression('sleep', 0);
      if (!silent) sayLine('sleep', { hold: 3600, sleep: true });
      if (state.whisperTimer) clearTimeout(state.whisperTimer);
      if (state.idleTimer) clearInterval(state.idleTimer);
    }

    function wakeOrSleep() {
      if (state.sleeping) wake();
      else goSleep(false);
    }

    function touchInteraction() {
      state.lastInteractionAt = Date.now();
      if (state.sleeping) wake();
      scheduleSleep();
    }

    function scheduleSleep() {
      if (state.sleepTimer) clearTimeout(state.sleepTimer);
      var minutes = state.config && typeof state.config.sleepAfterMin === 'number' ? state.config.sleepAfterMin : 0;
      if (!minutes || minutes <= 0) return;
      state.sleepTimer = setTimeout(function () {
        if (state.destroyed || state.sleeping || state.chatOpened) return;
        goSleep(true);
      }, minutes * 60 * 1000);
    }

    function scheduleWhisper() {
      if (state.whisperTimer) clearTimeout(state.whisperTimer);
      if (!state.config || !state.config.whisperEnabled) return;
      var base = (state.config.whisperIntervalSec || 240) * 1000;
      var delay = base * (0.65 + Math.random() * 0.7);
      state.whisperTimer = setTimeout(function () {
        state.whisperTimer = null;
        if (state.destroyed) return;
        if (state.sleeping || state.busy || state.hidden || state.chatOpened || document.hidden) {
          scheduleWhisper();
          return;
        }
        api
          .call('whisper')
          .then(function (value) {
            if (state.destroyed || state.sleeping || state.hidden) return;
            var text = value && typeof value.text === 'string' ? value.text : '';
            if (!text) return;
            say(text, { hold: 5200 });
          })
          .catch(function () {})
          .then(function () {
            if (!state.destroyed) scheduleWhisper();
          });
      }, delay);
    }

    /** 空闲时的小动作：左右看、伸懒腰、轻轻晃。 */
    function startIdleLoop() {
      if (state.idleTimer) clearInterval(state.idleTimer);
      state.idleTimer = setInterval(function () {
        if (state.destroyed || state.sleeping || state.busy || state.hidden) return;
        var roll = Math.random();
        if (roll < 0.16) {
          pet.classList.add('is-look-left');
          setTimeout(function () {
            if (!state.destroyed) pet.classList.remove('is-look-left');
          }, 1600);
        } else if (roll < 0.32) {
          pet.classList.add('is-look-right');
          setTimeout(function () {
            if (!state.destroyed) pet.classList.remove('is-look-right');
          }, 1600);
        } else if (roll < 0.44) {
          pet.classList.add('is-stretch');
          setTimeout(function () {
            if (!state.destroyed) pet.classList.remove('is-stretch');
          }, 1200);
        }
      }, 14000);
    }

    /** 页内随机溜达（桌面模式窗口自己动，反而奇怪，所以只在页内走）。 */
    function maybeWander() {
      if (mode !== 'web' || state.sleeping || state.busy || state.hidden || state.chatOpened) return;
      if (Math.random() > 0.5) return;
      var size = petSize();
      var distance = 60 + Math.random() * 150;
      var goLeft = state.pos.x + distance > window.innerWidth - size.width || state.pos.x - distance < 0 ? state.pos.x - distance < 0 : Math.random() < 0.5;
      var targetX = clamp(state.pos.x + (goLeft ? -distance : distance), 0, window.innerWidth - size.width);
      var target = { x: targetX, y: state.pos.y };
      state.flip = targetX < state.pos.x;
      pet.classList.toggle('is-flip', ART_MODE !== 'sprite' && state.flip);
      pet.classList.add('is-walking');
      if (ART_MODE === 'sprite') playSprite(goLeft ? 'walkLeft' : 'walkRight');
      applyPos(target);
      setTimeout(function () {
        if (state.destroyed) return;
        pet.classList.remove('is-walking');
        if (ART_MODE === 'sprite' && !state.sleeping) spriteIdle();
      }, 2300);
    }

    // ── 互动 ────────────────────────────────────────────────────────────────
    function pat() {
      setExpression(Math.random() < 0.5 ? 'shy' : 'sparkle', 2600);
      sayLine('headpat', { hold: 3600 });
      if (Math.random() < 0.3) {
        setTimeout(function () {
          if (!state.destroyed) setExpression('love', 2200);
        }, 1200);
      }
      resetIdleSpeech();
    }

    function eatIcecream() {
      if (state.sleeping) wake();
      if (ART_MODE === 'sprite') {
        setExpression('happy', 5200);
      } else {
        setExpression('eat', 7000);
      }
      sayLine('icecream', { hold: 5200 });
      setTimeout(function () {
        if (!state.destroyed) {
          pet.classList.remove('is-eat');
          if (ART_MODE === 'sprite') spriteIdle();
        }
      }, 7000);
      resetIdleSpeech();
    }

    function reactToClick() {
      if (state.sleeping) {
        wake();
        return;
      }
      if (state.chatOpened) return;
      if (ART_MODE === 'sprite') {
        playSprite('wave', { onDone: spriteIdle });
        sayLine('click', { hold: 3200 });
        resetIdleSpeech();
        return;
      }
      var roll = Math.random();
      if (roll < 0.45) pat();
      else if (roll < 0.6) eatIcecream();
      else {
        sayLine('click', { hold: 3200 });
        if (roll > 0.86) setExpression('happy', 1800);
        else setExpression(Math.random() < 0.5 ? 'shy' : '', 2200);
      }
      resetIdleSpeech();
    }

    function resetIdleSpeech() {
      scheduleWhisper();
    }

    // ── 聊天面板 ────────────────────────────────────────────────────────────
    function appendChatRow(role, text) {
      var row = el('div', 'erii-chat-row ' + role, text);
      chatList.appendChild(row);
      chatList.scrollTop = chatList.scrollHeight;
    }

    function openChat() {
      state.chatOpened = true;
      menu.hidden = true;
      chat.hidden = false;
      layoutPanels();
      chatInput.focus({ preventScroll: true });
      if (chatList.childElementCount === 0) {
        appendChatRow('her', pick(state.lines.greeting));
      }
      resetIdleSpeech();
    }

    function closeChat() {
      state.chatOpened = false;
      chat.hidden = true;
      chatInput.blur();
    }

    function sendChat(text) {
      var trimmed = String(text || '').trim();
      if (trimmed === '' || state.chatBusy) return;
      state.chatBusy = true;
      appendChatRow('user', trimmed);
      chatInput.value = '';
      touchInteraction();
      api
        .call('chat', { text: trimmed })
        .then(function (value) {
          state.chatBusy = false;
          if (state.destroyed) return;
          if (value && value.ok && value.text) {
            appendChatRow('her', value.text);
            say(value.text, { hold: 6200 });
          } else {
            var fallback = (value && value.fallback) || pick(state.lines.chatFail);
            appendChatRow('her', fallback);
            say(fallback, { hold: 4200 });
          }
        })
        .catch(function (error) {
          state.chatBusy = false;
          if (state.destroyed) return;
          var fallback = pick(state.lines.chatFail);
          appendChatRow('her', fallback);
          say(fallback, { hold: 4200 });
        });
    }

    chatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      sendChat(chatInput.value);
    });
    chatClose.addEventListener('click', closeChat);

    // ── 菜单 ────────────────────────────────────────────────────────────────
    function openMenu() {
      menu.hidden = false;
      layoutPanels();
    }

    function closeMenu() {
      menu.hidden = true;
    }

    function syncMenuLabels() {
      if (!state.config) return;
      menuButtons.voice.textContent = '声音：' + (state.config.voiceEnabled ? '开' : '关');
      menuButtons.desktop.textContent = mode === 'desktop' ? '回到网页里' : state.config.desktopEnabled ? '收起桌面宠物' : '到桌面上去';
      menuButtons.sleep.textContent = state.sleeping ? '叫醒她' : '让她睡一会儿';
    }

    function menuAction(id) {
      closeMenu();
      if (id === 'pat') pat();
      else if (id === 'icecream') eatIcecream();
      else if (id === 'talk') openChat();
      else if (id === 'sleep') wakeOrSleep();
      else if (id === 'voice') {
        state.config.voiceEnabled = !state.config.voiceEnabled;
        saveConfig({ voiceEnabled: state.config.voiceEnabled });
        syncMenuLabels();
        if (state.config.voiceEnabled) say('声音，打开了。', { hold: 2400 });
      } else if (id === 'desktop') {
        var enabled = !(mode === 'desktop' ? true : state.config.desktopEnabled);
        saveConfig({ desktopEnabled: enabled, display: enabled ? 'both' : 'web' });
        syncMenuLabels();
      } else if (id === 'settings') openSettings();
      else if (id === 'hide') hidePet();
    }

    menu.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-act]');
      if (button) menuAction(button.getAttribute('data-act'));
    });

    // ── 设置 ────────────────────────────────────────────────────────────────
    var settingsFields = {};

    function buildSettings() {
      settingsBody.innerHTML = '';
      settingsFields = {};
      var config = state.config;

      function row(labelText, control) {
        var label = el('label');
        label.appendChild(el('span', '', labelText));
        label.appendChild(control);
        settingsBody.appendChild(label);
      }

      // 音量
      var volume = el('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '1';
      volume.step = '0.05';
      volume.value = String(config.volume);
      volume.addEventListener('input', function () {
        saveConfig({ volume: Number(volume.value) });
      });
      row('声音大小', volume);

      // 音色
      var voice = el('select');
      for (var i = 0; i < VOICES.length; i += 1) {
        var option = el('option', '', VOICES[i].name);
        option.value = VOICES[i].id;
        voice.appendChild(option);
      }
      voice.value = config.voice;
      voice.addEventListener('change', function () {
        saveConfig({ voice: voice.value });
        say('这个声音，可以吗。', { hold: 2600 });
      });
      row('她的声音', voice);

      // 称呼
      var name = el('input');
      name.type = 'text';
      name.value = config.userName;
      name.maxLength = 16;
      name.addEventListener('change', function () {
        saveConfig({ userName: name.value.trim() || 'Sakura' });
      });
      row('怎么叫你', name);

      // 大小
      var size = el('input');
      size.type = 'range';
      size.min = '120';
      size.max = '360';
      size.step = '10';
      size.value = String(config.size);
      size.addEventListener('input', function () {
        saveConfig({ size: Number(size.value) });
        applyPos(normalizedPos(state.pos));
      });
      row('她的个子', size);

      // 自言自语
      var whisperLabel = el('span', '', '自己碎碎念');
      var whisper = el('input');
      whisper.type = 'checkbox';
      whisper.checked = config.whisperEnabled;
      whisper.addEventListener('change', function () {
        saveConfig({ whisperEnabled: whisper.checked });
        if (whisper.checked) scheduleWhisper();
        else if (state.whisperTimer) clearTimeout(state.whisperTimer);
      });
      whisperLabel.appendChild(whisper);
      row('自己碎碎念', whisperLabel);

      // 桌面模式（页内才有意义）
      if (mode === 'web') {
        var deskLabel = el('span', '', '同时在桌面显示');
        var desk = el('input');
        desk.type = 'checkbox';
        desk.checked = config.desktopEnabled;
        desk.addEventListener('change', function () {
          saveConfig({ desktopEnabled: desk.checked, display: desk.checked ? 'both' : 'web' });
        });
        deskLabel.appendChild(desk);
        row('同时在桌面显示', deskLabel);
      }

      settingsBody.appendChild(el('div', 'hint', '提示：右键宠物可以摸头、喂冰淇淋、说话。桌面模式会打开一个透明小窗，关掉 DSH 也会一起消失。'));

      var foot = el('div', 'erii-settings-foot');
      var close = el('button', 'erii-btn primary', '好了');
      close.type = 'button';
      close.addEventListener('click', closeSettings);
      foot.appendChild(close);
      settingsBody.appendChild(foot);
      void config;
    }

    function openSettings() {
      buildSettings();
      settings.hidden = false;
      layoutPanels();
    }

    function closeSettings() {
      settings.hidden = true;
    }

    settingsClose.addEventListener('click', closeSettings);

    // ── 配置保存 ────────────────────────────────────────────────────────────
    function applyConfig(next) {
      state.config = next;
      if (state.lines) state.userName = next.userName || state.userName;
      var show = next.display !== 'none' && (mode === 'desktop' ? next.display !== 'web' : next.display !== 'desktop');
      state.hidden = !show;
      stage.classList.toggle('is-hidden', state.hidden);
      dock.hidden = !state.hidden;
      var size = petSize();
      pet.style.width = size.width + 'px';
      pet.style.height = size.height + 'px';
      applyPos(normalizedPos(state.pos));
      syncMenuLabels();
      scheduleWhisper();
      scheduleSleep();
    }

    function saveConfig(patch) {
      if (!state.config) return;
      state.config = Object.assign({}, state.config, patch);
      applyConfig(state.config);
      api.call('config', { patch: patch }).catch(function () {});
    }

    // ── 指针：点击 / 拖拽 / 右键 / 命中 ─────────────────────────────────────
    var drag = null;

    function onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (state.hidden) return;
      var point = pointOf(event);
      drag = {
        startX: point.x,
        startY: point.y,
        origin: { x: state.pos.x, y: state.pos.y },
        moved: false,
        at: Date.now(),
      };
      pet.classList.add('is-dragging');
      if (mode === 'desktop' && api.dragStart) api.dragStart();
      if (event.pointerId !== undefined && figure.setPointerCapture) {
        try {
          figure.setPointerCapture(event.pointerId);
        } catch (error) {
          /* 某些环境不支持捕获 */
        }
      }
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!drag) return;
      var point = pointOf(event);
      var dx = point.x - drag.startX;
      var dy = point.y - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
        drag.moved = true;
        touchInteraction();
        if (state.sleeping) wake();
        if (ART_MODE === 'sprite') playSprite('walkRight', { loop: true });
        sayLine('pickup', { hold: 2400, voice: true });
      }
      if (mode === 'web' && drag.moved) {
        var size = petSize();
        state.posLocked = true;
        applyPos({
          x: clamp(drag.origin.x + dx, 0, window.innerWidth - size.width),
          y: clamp(drag.origin.y + dy, 0, window.innerHeight - size.height),
        });
      }
    }

    function onPointerUp(event) {
      if (!drag) return;
      var wasClick = !drag.moved;
      var duration = Date.now() - drag.at;
      pet.classList.remove('is-dragging');
      if (mode === 'desktop' && api.dragEnd) api.dragEnd();
      drag = null;
      if (wasClick && duration < 600) reactToClick();
      else if (mode === 'web') {
        // 松手后轻轻落回屏幕底部（不做完整抛掷物理，保持手感安静）。
        var size = petSize();
        var floorY = Math.max(0, window.innerHeight - size.height - 8);
        if (state.pos.y < floorY) {
          pet.classList.add('is-settling');
          applyPos({ x: state.pos.x, y: floorY });
          setTimeout(function () {
            if (!state.destroyed) pet.classList.remove('is-settling');
          }, 620);
        }
        if (api.saveWebPosition) api.saveWebPosition(state.pos);
      }
      if (ART_MODE === 'sprite' && !state.sleeping) spriteIdle();
    }

    function onContextMenu(event) {
      if (state.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      syncMenuLabels();
      openMenu();
    }

    figure.addEventListener('pointerdown', onPointerDown);
    figure.addEventListener('pointermove', onPointerMove);
    figure.addEventListener('pointerup', onPointerUp);
    figure.addEventListener('pointercancel', onPointerUp);
    figure.addEventListener('contextmenu', onContextMenu);

    // 命中区 → 桌面窗口的鼠标穿透开关
    var lastInteractive = null;
    function updateInteractive(event) {
      if (mode !== 'desktop' || !api.setInteractive) return;
      var hit = false;
      var target = event.target;
      if (target && target.closest) hit = Boolean(target.closest('.erii-figure,.erii-menu,.erii-panel,.erii-dock'));
      if (!hit) {
        // 气泡本身不接鼠标，但手指在立绘上时仍要能拖。
        var element = document.elementFromPoint(event.clientX, event.clientY);
        hit = Boolean(element && element.closest && element.closest('.erii-figure,.erii-menu,.erii-panel,.erii-dock'));
      }
      if (hit !== lastInteractive) {
        lastInteractive = hit;
        api.setInteractive(hit);
      }
    }
    document.addEventListener('mousemove', updateInteractive, true);

    // 点击空白处收起菜单
    document.addEventListener('pointerdown', function (event) {
      if (!menu.hidden && !event.target.closest('.erii-menu') && !event.target.closest('.erii-figure')) closeMenu();
    }, true);

    // 视口变化：夹回可视区
    function onResize() {
      if (mode !== 'web') return;
      applyPos(normalizedPos(state.pos));
    }
    window.addEventListener('resize', onResize);

    // 键盘：Esc 收起面板
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (!menu.hidden) closeMenu();
      if (!chat.hidden) closeChat();
      if (!settings.hidden) closeSettings();
    }
    document.addEventListener('keydown', onKeyDown);

    // ── 启动 ────────────────────────────────────────────────────────────────
    function boot() {
      api
        .init()
        .then(function (data) {
          if (state.destroyed) return;
          state.lines = (data && data.lines && data.lines.sets) || FALLBACK_LINES;
          state.userName = (data && data.lines && data.lines.userName) || 'Sakura';
          var config = (data && data.config) || {};
          state.config = config;
          if (mode === 'web' && api.loadWebPosition) {
            state.pos = api.loadWebPosition();
            state.posLocked = Boolean(state.pos);
          }
          applyConfig(config);
          state.ready = true;
          spriteIdle();
          startIdleLoop();
          scheduleWhisper();
          scheduleSleep();
          // 窗口刚建好时 innerWidth 可能还是 0：等一帧后再按真实尺寸落位一次。
          setTimeout(function () {
            if (state.destroyed) return;
            applyPos(normalizedPos(state.posLocked ? state.pos : null));
          }, 260);
          setTimeout(function () {
            if (state.destroyed || state.hidden) return;
            sayLine('greeting', { hold: 4200 });
          }, 900);
          setInterval(function () {
            maybeWander();
          }, 26000);
        })
        .catch(function (error) {
          // 宿主配置拿不到也要能出现：用默认值把宠物先立起来。
          state.config = {
            display: 'both',
            desktopEnabled: false,
            voiceEnabled: false,
            voice: 'zh-CN-XiaoyiNeural',
            volume: 0.9,
            size: 210,
            userName: 'Sakura',
            whisperEnabled: false,
            whisperIntervalSec: 240,
            sleepAfterMin: 0,
          };
          applyConfig(state.config);
          state.ready = true;
          spriteIdle();
          startIdleLoop();
          say('……', { hold: 2600, voice: false });
          void error;
        });
    }

    function hidePet() {
      state.hidden = true;
      closeMenu();
      stage.classList.add('is-hidden');
      dock.hidden = false;
    }

    /** 从「躲起来」状态叫回来；顺手把持久化的 display 修正成 both。 */
    function restorePet() {
      state.hidden = false;
      stage.classList.remove('is-hidden');
      dock.hidden = true;
      if (state.config) state.config.display = 'both';
      saveConfig({ display: 'both' });
      applyConfig(state.config || {});
    }

    function destroy() {
      state.destroyed = true;
      clearActionTimers();
      if (state.audio) {
        try {
          state.audio.pause();
        } catch (error) {
          /* 忽略 */
        }
      }
      document.removeEventListener('mousemove', updateInteractive, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      if (api.onEvent) api.onEventUnsubscribe = undefined;
      stage.remove();
      style.remove();
      if (dock) dock.remove();
    }

    boot();

    // 调试钩子：宿主诊断截图可以指定图集动作，也方便手工在 devtools 里试帧。
    try {
      global.__eriiPet = {
        playSprite: playSprite,
        say: say,
        sleep: goSleep,
        wake: wake,
        pat: pat,
        eat: eatIcecream,
        sprite: spriteEl,
        hide: hidePet,
        restore: restorePet,
        spriteImageInfo: function () {
          return spriteImage
            ? {
                ok: spriteImage.complete,
                w: spriteImage.naturalWidth,
                h: spriteImage.naturalHeight,
                cols: SPRITE.cols,
                rows: SPRITE.rows,
                anim: spriteAnim,
              }
            : null;
        },
      };
    } catch (error) {
      /* 忽略 */
    }

    return { destroy: destroy, stage: stage, say: say, showBubble: showBubble };
  }

  /** 自绘的冰淇淋小道具（透明底，跟着立绘缩放）。 */
  var ICECREAM_SVG =
    '<svg viewBox="0 0 120 170" xmlns="http://www.w3.org/2000/svg" style="position:absolute;right:7%;bottom:22%;width:24%;height:auto;filter:drop-shadow(0 4px 6px rgba(40,8,16,.25));transform:rotate(8deg);">' +
    '<path d="M34 92 L86 92 L60 162 Z" fill="#e8b06a" stroke="#b9813f" stroke-width="2"/>' +
    '<path d="M40 100 L60 156 M52 96 L62 142 M68 96 L62 132" stroke="#c9924d" stroke-width="1.2" opacity=".7"/>' +
    '<circle cx="60" cy="66" r="24" fill="#f6d7e0" stroke="#d89fb3" stroke-width="2"/>' +
    '<circle cx="44" cy="46" r="16" fill="#f9e6c8" stroke="#dcb894" stroke-width="2"/>' +
    '<circle cx="76" cy="46" r="16" fill="#d9ecf7" stroke="#9dbfd4" stroke-width="2"/>' +
    '<circle cx="60" cy="34" r="12" fill="#f6d7e0" stroke="#d89fb3" stroke-width="2"/>' +
    '<path d="M30 84 Q60 96 90 84" stroke="#e6c3cd" stroke-width="2" fill="none"/>' +
    '</svg>';

  /** 位图立绘的表情叠层：不用 SVG 坐标，按百分比贴在脸上（任何构图都能用）。 */
  var RASTER_FX_HTML =
    '<div class="erii-blush erii-blush-a"></div><div class="erii-blush erii-blush-b"></div>' +
    '<div class="erii-zzz">z z</div>';

  /** 表情特效层：坐标按 420×560 立绘画布。 */
  var FX_SVG = [
    '<svg viewBox="0 0 420 560" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">',
    '<g class="fx-blush"><ellipse cx="152" cy="318" rx="26" ry="11" fill="#e9738a" opacity=".38"/>',
    '<ellipse cx="268" cy="318" rx="26" ry="11" fill="#e9738a" opacity=".38"/></g>',
    '<g class="fx-zzz" fill="#f6e9ef" stroke="#7a2437" stroke-width="1.4" font-family="KaiTi,serif" font-size="26">',
    '<text x="300" y="130">z</text><text x="322" y="106" font-size="20">z</text><text x="340" y="86" font-size="15">z</text></g>',
    '<path class="fx-tear" d="M282 318 q6 12 0 18 q-6 -6 0 -18" fill="#bfe3f2" opacity=".9"/>',
    '<g class="fx-spark" fill="#f7d77c">',
    '<path d="M96 170 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z"/>',
    '<path d="M330 210 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z"/>',
    '<path d="M120 96 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z"/></g>',
    '<g class="fx-heart" fill="#e05a7a">',
    '<path d="M300 120 c-6 -10 -22 -6 -22 6 c0 10 14 16 22 24 c8 -8 22 -14 22 -24 c0 -12 -16 -16 -22 -6z" opacity=".85"/>',
    '</g>',
    '</svg>',
  ].join('');

  global.createEriPet = createEriPet;
})(window);

