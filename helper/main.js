/**
 * 绘梨衣桌宠的桌面小窗（Electron 主进程）。
 *
 * 一个透明、无边框、置顶、不占任务栏的小窗，只负责「把渲染端放在桌面上」：
 *  - 窗口位置由宿主配置恢复，拖拽时用系统光标轮询移动窗口（光标跑出窗口也不断）；
 *  - 默认整窗鼠标穿透，渲染端在自己的命中区上通过 `interactive` 把穿透关掉；
 *  - 与宿主只走 stdio 行协议，转发渲染端的 call / result。
 *
 * 这个文件不引用插件里的任何模块：它由 Electron 自己的 Node 运行，只做窗口与管道。
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 620;

/** @type {BrowserWindow | null} */
let win = null;
let dragTimer = null;
let dragOffset = { x: 0, y: 0 };
let quitting = false;
/** 与宿主之间的本地 socket（宿主连进来之后，两边都用它收发协议消息）。 */
let hostSocket = null;

/** 往宿主 stdout 写一行 JSON（只用于端口与日志：Electron 的 stdin 在 Windows 上不可靠）。 */
function sendLine(message) {
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch {
    /* 宿主已退出 */
  }
}

/** 发一条协议消息给宿主：socket 优先，未连上时退回 stdout。 */
function sendToHost(message) {
  if (hostSocket && !hostSocket.destroyed) {
    try {
      hostSocket.write(JSON.stringify(message) + '\n');
      return;
    } catch {
      /* 退回 stdout */
    }
  }
  sendLine(message);
}

/**
 * 写一份启动状态到宿主给的文件：没有控制台时，这是「桌面窗到底起没起来」的唯一证据。
 * @param {Record<string, unknown>} status
 */
function writeStatus(status) {
  const file = process.env.ERII_STATUS_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...status, at: Date.now() }, null, 2), 'utf8');
  } catch {
    /* 状态文件写不进去不影响窗口 */
  }
}

/**
 * 追加一行事件日志到状态文件同目录的 helper.log：诊断「stdin 有没有通、页面有没有收到 state」。
 * @param {string} message
 */
function logEvent(message) {
  const statusFile = process.env.ERII_STATUS_FILE;
  if (!statusFile) return;
  try {
    fs.appendFileSync(path.join(path.dirname(statusFile), 'helper.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* 日志失败不影响窗口 */
  }
}

/** 桌面配置里的窗口位置（可能为空）。 */
function initialPosition() {
  const raw = process.env.ERII_DESKTOP_POSITION;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
    } catch {
      /* 回默认位置 */
    }
  }
  return null;
}

/** 把窗口夹进当前显示器的工作区，避免换屏后跑到看不见的地方。 */
function clampToDisplay(x, y) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  return {
    x: Math.min(Math.max(x, area.x - WINDOW_WIDTH + 80), area.x + area.width - 80),
    y: Math.min(Math.max(y, area.y - WINDOW_HEIGHT + 80), area.y + area.height - 80),
  };
}

/** 默认落点：主屏右下角，留一点边距。 */
function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - WINDOW_WIDTH - 16, y: area.y + area.height - WINDOW_HEIGHT - 8 };
}

function createWindow() {
  const saved = initialPosition();
  const target = saved ? clampToDisplay(saved.x, saved.y) : defaultPosition();
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: target.x,
    y: target.y,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    const [x, y] = win.getPosition();
    writeStatus({ ok: true, phase: 'ready-to-show', bounds: { x, y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT } });
  });
  win.webContents.on('did-finish-load', () => {
    writeStatus({ ok: true, phase: 'did-finish-load' });
    logEvent('did-finish-load');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    writeStatus({ ok: false, phase: 'render-process-gone', detail: details });
  });
  win.on('closed', () => {
    win = null;
  });
  // 桌面小窗只展示本地页面：禁止导航与新窗口，避免被页面里的链接带走。
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** 渲染端报到：告诉宿主可以推状态了。 */
ipcMain.on('erii:hello', () => {
  logEvent('ipc hello');
  sendToHost({ type: 'ready' });
});

/** 渲染端转发给宿主的一次调用。 */
ipcMain.on('erii:to-host', (_event, message) => {
  if (message && typeof message === 'object') sendToHost(message);
});

/** 鼠标穿透开关：只有宠物 / 面板的命中区才接鼠标。 */
ipcMain.on('erii:interactive', (_event, interactive) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
});

/** 开始拖窗：记录「窗口原点 - 光标」的偏移，之后让窗口追着光标跑。 */
ipcMain.on('erii:drag-start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragOffset = { x: x - cursor.x, y: y - cursor.y };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win) return;
    const point = screen.getCursorScreenPoint();
    win.setPosition(point.x + dragOffset.x, point.y + dragOffset.y, false);
  }, 16);
});

/** 结束拖窗：停轮询，把落点报给宿主保存。 */
ipcMain.on('erii:drag-end', () => {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (!win) return;
  const [x, y] = win.getPosition();
  const clamped = clampToDisplay(x, y);
  if (clamped.x !== x || clamped.y !== y) win.setPosition(clamped.x, clamped.y, false);
  sendLine({ type: 'move', ...clamped });
});

ipcMain.on('erii:quit', () => {
  quitting = true;
  app.quit();
});

/** 宿主请求一张当前小窗的截图（诊断用：确认透明窗里真的画出了宠物）。 */
async function captureWindow(action) {
  if (!win || win.isDestroyed()) {
    sendLine({ type: 'log', message: 'capture: no window' });
    return;
  }
  try {
    // 调试：可指定一段图集动作（idle / wave / sleep / emote / walkRight）或 hide / show。
    if (typeof action === 'string' && /^[a-zA-Z]+$/.test(action)) {
      const call =
        action === 'hide'
          ? 'window.__eriiPet && window.__eriiPet.hide()'
          : action === 'show'
            ? 'window.__eriiPet && window.__eriiPet.restore()'
            : "window.__eriiPet && window.__eriiPet.playSprite(" + JSON.stringify(action) + ")";
      await win.webContents.executeJavaScript('(() => { ' + call + '; })()', true);
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
    // 等一帧让动作/布局稳定。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await win.webContents.capturePage();
    const file = process.env.ERII_CAPTURE_FILE || path.join(app.getPath('temp'), 'erii-capture.png');
    fs.writeFileSync(file, image.toPNG());
    let layout = '';
    try {
      layout = await win.webContents.executeJavaScript(
        "(() => { const p = document.querySelector('.erii-pet'); const f = document.querySelector('.erii-figure svg');" +
          " const r = p ? p.getBoundingClientRect() : null; const fr = f ? f.getBoundingClientRect() : null;" +
          " return JSON.stringify({ iw: innerWidth, ih: innerHeight, transform: p ? p.style.transform : ''," +
          " rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null," +
          " art: fr ? { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) } : null," +
          " sprite: (() => { const s = document.querySelector('.erii-sprite'); if (!s) return null; const cs = getComputedStyle(s); const r = s.getBoundingClientRect(); return { w: cs.width, h: cs.height, bs: s.style.backgroundSize, bp: s.style.backgroundPosition, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, natural: s.style.backgroundImage ? s.style.backgroundImage.slice(0, 40) : '' }; })()," +
          " bubble: document.querySelector('.erii-bubble') ? { hidden: document.querySelector('.erii-bubble').hidden, text: document.querySelector('.erii-bubble').textContent } : null }); })()",
        true,
      );
    } catch (error) {
      layout = 'layout probe failed: ' + String((error && error.message) || error);
    }
    writeStatus({ ok: true, phase: 'capture', file, layout });
    sendLine({ type: 'log', message: 'capture: ' + file + ' ' + layout });
  } catch (error) {
    sendLine({ type: 'log', message: 'capture failed: ' + String((error && error.message) || error) });
  }
}

ipcMain.on('erii:capture', () => {
  void captureWindow();
});

/** 宿主发来的行 → 渲染端事件。 */
function dispatchHostMessage(message) {
  if (!message || typeof message !== 'object') return;
  logEvent('dispatch ' + String(message.type));
  if (message.type === 'quit') {
    quitting = true;
    app.quit();
    return;
  }
  if (message.type === 'capture') {
    void captureWindow(message.action);
    return;
  }
  if (win && !win.isDestroyed()) win.webContents.send('erii:event', message);
}

/** 多开保护：同一时间只允许一个桌面小窗。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) win.showInactive();
  });
  app.whenReady().then(() => {
    createWindow();
    // 本地回环 socket 作为双向协议通道：Electron 的 stdin 在 Windows 上并不可靠，
    // 而宿主发起的 HTTP 在桌面版里会被拦；loopback TCP 两头都通，且端口随机、只连本机。
    const server = net.createServer((socket) => {
      hostSocket = socket;
      socket.setEncoding('utf8');
      let buffer = '';
      logEvent('host connected');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim() !== '') {
            logEvent('socket ' + line.slice(0, 120));
            try {
              dispatchHostMessage(JSON.parse(line));
            } catch {
              /* 非 JSON 行忽略 */
            }
          }
          index = buffer.indexOf('\n');
        }
      });
      socket.on('close', () => {
        logEvent('host disconnected');
        if (hostSocket === socket) hostSocket = null;
      });
      socket.on('error', (error) => logEvent('host socket error ' + String((error && error.message) || error)));
    });
    server.on('error', (error) => logEvent('bridge server error ' + String((error && error.message) || error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      logEvent('bridge port ' + port);
      sendLine({ type: 'bridge-port', port });
    });
    screen.on('display-metrics-changed', () => {
      if (!win) return;
      const [x, y] = win.getPosition();
      const clamped = clampToDisplay(x, y);
      win.setPosition(clamped.x, clamped.y, false);
    });
  });
  app.on('window-all-closed', () => {
    quitting = true;
    app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
}

process.on('uncaughtException', (error) => {
  writeStatus({ ok: false, phase: 'uncaughtException', error: String((error && error.message) || error) });
  try {
    sendLine({ type: 'log', message: 'helper uncaught: ' + String((error && error.stack) || error) });
  } catch {
    /* 忽略 */
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeStatus({ ok: false, phase: 'unhandledRejection', error: String(reason) });
});

