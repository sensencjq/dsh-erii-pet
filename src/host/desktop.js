/**
 * 桌面模式（宿主半侧）：拉起一个透明、置顶、无边框的 Electron 小窗，把同一份宠物立绘
 * 放到真正的桌面上，而不是只叠在 DSH 页面里。
 *
 * 与 Helper 的通信只走 stdio（一行一个 JSON），不开放任何端口：
 * 桌面版 DSH 会拦插件自拉进程发起的裸 HTTP 请求，走管道是唯一稳定路径，
 * 也避免多一个本地监听面。渲染端要语音 / 聊天时发 `call`，宿主处理完回 `result`。
 *
 * @module dsh-erii-pet/src/host/desktop
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, lineSet, lines, whisper } from './llm.js';
import { appendMemory, dataDir, hostLog, loadConfig, recentHistory, sanitizeConfig, saveConfig } from './store.js';
import { speechOf } from './voice.js';

/** 包根目录。 */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Helper 目录（Electron 应用目录）。 */
const HELPER_DIR = join(PACKAGE_ROOT, 'helper');

/** 允许前端读到的台词组（与 routes.js 保持一致）。 */
const LINE_KEYS = [
  'greeting',
  'click',
  'idleWhisper',
  'drag',
  'pickup',
  'icecream',
  'sleep',
  'wake',
  'headpat',
  'chatFail',
];

/** 重启退避（ms）；用完就停在 stopped，等一次设置变更再试。 */
const RESTART_DELAYS = [1500, 4000, 9000];

/**
 * 找 Electron 可执行文件：环境变量优先，其次 DSH 共享的 Electron 目录（dsh-pet 也是这一份）。
 * @returns {string | undefined}
 */
export function resolveElectronPath() {
  const fromEnv = process.env.ERII_ELECTRON_PATH;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    if (existsSync(fromEnv)) return fromEnv;
  }
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
  const candidates =
    process.platform === 'win32'
      ? [join(home, 'electron', 'electron.exe')]
      : [join(home, 'electron', 'electron'), join(home, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 台词包（与 HTTP /lines 同构）。 */
function lineBundle() {
  const sets = {};
  for (const key of LINE_KEYS) sets[key] = lineSet(key);
  return { userName: lines().userName || 'Sakura', sets };
}

/** 随机取一条台词。 */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 创建桌面 Helper 管理器。
 * @param {{ ctx: any, log: (level: 'info'|'warn', message: string) => void }} deps
 */
export function createDesktop(deps) {
  const { ctx, log } = deps;

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  let disposed = false;
  let desired = false;
  let restartAttempt = 0;
  let restartTimer;
  let ready = false;
  let stopReason;
  let buffer = '';
  let socketBuffer = '';
  let moveTimer;
  let pendingMove;
  /** @type {import('node:net').Socket | undefined} */
  let socket;
  /** socket 还没连上时的待发消息。 */
  let outbox = [];

  const status = () => ({
    running: Boolean(child) && ready,
    spawned: Boolean(child),
    reason: stopReason,
    electron: resolveElectronPath() !== undefined,
  });

  /** 让 Helper 截一张当前小窗的图（诊断：确认透明窗真的画出了宠物）。 */
  const capture = (action) => {
    if (!child) {
      hostLog('capture requested but helper is not running');
      return { ok: false, error: '桌面 Helper 没有运行' };
    }
    write({ type: 'capture', action: typeof action === 'string' ? action : undefined });
    const file = join(dataDir(), 'capture.png');
    hostLog(`capture requested pid=${child.pid} action=${String(action ?? '-')}`);
    return { ok: true, file };
  };

  /** 把一条消息写进 Helper：优先走本地 socket，未连上先排队。 */
  const write = (message) => {
    const line = JSON.stringify(message) + '\n';
    if (socket && !socket.destroyed) {
      try {
        socket.write(line);
        return;
      } catch {
        /* 落到 outbox */
      }
    }
    outbox.push(line);
  };

  /** 把完整状态推给 Helper（启动与配置变更时）。 */
  const pushState = () => {
    const config = loadConfig();
    write({ type: 'state', config, lines: lineBundle() });
    hostLog('push state to helper');
  };

  /** 处理渲染端的一次请求。 */
  const handleCall = async (message) => {
    const { id, method, params } = message;
    const reply = (ok, value, error) => write({ type: 'result', id, ok, ...(ok ? { value } : { error }) });
    try {
      if (method === 'lines') {
        const config = loadConfig();
        reply(true, { config, lines: lineBundle() });
        return;
      }
      if (method === 'voice') {
        const config = loadConfig();
        const audio = await speechOf({
          text: String(params?.text ?? ''),
          voice: String(params?.voice ?? config.voice),
          rate: String(params?.rate ?? config.rate),
          pitch: String(params?.pitch ?? config.pitch),
          volume: String(params?.volume ?? config.ttsVolume),
        });
        reply(true, { base64: audio.toString('base64'), mime: 'audio/mpeg' });
        return;
      }
      if (method === 'chat') {
        const config = loadConfig();
        const text = String(params?.text ?? '').trim().slice(0, 500);
        try {
          const result = await chat(ctx, config, text, recentHistory(config.memoryRounds));
          appendMemory({ role: 'user', text });
          appendMemory({ role: 'assistant', text: result.text });
          reply(true, { text: result.text });
        } catch (error) {
          log('warn', `desktop chat failed: ${error instanceof Error ? error.message : String(error)}`);
          reply(false, undefined, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (method === 'whisper') {
        const config = loadConfig();
        try {
          const text = await whisper(ctx, config);
          reply(true, { text });
        } catch {
          reply(true, { text: pick(lineSet('idleWhisper')), fallback: true });
        }
        return;
      }
      if (method === 'config') {
        const current = loadConfig();
        const patch = params?.patch && typeof params.patch === 'object' ? params.patch : {};
        const next = sanitizeConfig({ ...current, ...patch });
        saveConfig(next);
        sync(next);
        reply(true, { config: next, desktop: status() });
        return;
      }
      reply(false, undefined, 'unknown method');
    } catch (error) {
      write({
        type: 'result',
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** 行协议解析：Helper 的 stdout 只有 JSON 行。 */
  const onLine = (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log('warn', `desktop helper: 无法解析的消息 ${line.slice(0, 160)}`);
      return;
    }
    switch (message?.type) {
      case 'bridge-port':
        hostLog('bridge port ' + String(message.port));
        connectBridge(Number(message.port));
        break;
      case 'ready':
        ready = true;
        stopReason = undefined;
        restartAttempt = 0;
        pushState();
        hostLog('helper ready');
        log('info', 'erii 桌面 Helper 已就绪');
        break;
      case 'call':
        void handleCall(message);
        break;
      case 'move': {
        const x = Number(message.x);
        const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        pendingMove = { x: Math.round(x), y: Math.round(y) };
        if (moveTimer) return;
        moveTimer = setTimeout(() => {
          moveTimer = undefined;
          if (!pendingMove) return;
          const config = loadConfig();
          saveConfig({ ...config, desktopPosition: pendingMove });
          pendingMove = undefined;
        }, 600);
        break;
      }
      case 'log':
        hostLog('helper: ' + String(message.message ?? '').slice(0, 300));
        log('info', `desktop: ${String(message.message ?? '').slice(0, 300)}`);
        break;
      case 'quit':
        stop('helper 主动退出');
        break;
      default:
        break;
    }
  };

  /** 连上 Helper 的本地协议端口；连上后把排队的消息一次发出去。 */
  function connectBridge(port) {
    if (!Number.isFinite(port) || port <= 0) return;
    if (socket && !socket.destroyed) return;
    try {
      socket = netConnect({ port, host: '127.0.0.1' });
    } catch (error) {
      hostLog('bridge connect failed: ' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      hostLog(`bridge connected port=${port}`);
      const queued = outbox;
      outbox = [];
      for (const line of queued) {
        try {
          socket.write(line);
        } catch {
          /* 连接又断了：放弃这批 */
        }
      }
    });
    socket.on('data', (chunk) => {
      socketBuffer += chunk;
      let index = socketBuffer.indexOf('\n');
      while (index >= 0) {
        const line = socketBuffer.slice(0, index);
        socketBuffer = socketBuffer.slice(index + 1);
        onLine(line);
        index = socketBuffer.indexOf('\n');
      }
    });
    socket.on('error', (error) => hostLog('bridge error: ' + error.message));
    socket.on('close', () => {
      hostLog('bridge closed');
      socket = undefined;
    });
  }

  /** 断开协议 socket。 */
  const closeBridge = () => {
    if (!socket) return;
    try {
      socket.destroy();
    } catch {
      /* 已断开 */
    }
    socket = undefined;
    socketBuffer = '';
    outbox = [];
  };

  const onExit = (code, signal) => {
    const wasReady = ready;
    closeBridge();
    child = undefined;
    ready = false;
    hostLog(`helper exit code=${code} signal=${signal ?? '-'} desired=${desired} disposed=${disposed}`);
    log('warn', `erii 桌面 Helper 退出（code=${code}, signal=${signal ?? '-'}）`);
    if (disposed || !desired) return;
    if (restartAttempt >= RESTART_DELAYS.length) {
      stopReason = 'helper 反复崩溃，已停止重试';
      log('warn', stopReason);
      return;
    }
    const delay = RESTART_DELAYS[restartAttempt];
    restartAttempt += 1;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!disposed && desired && !child) start();
    }, delay);
    if (wasReady) log('info', `erii 桌面 Helper 将在 ${delay}ms 后重启`);
  };

  /** 启动 Helper（已启动时直接返回）。 */
  const start = () => {
    if (disposed || child) return;
    const electronPath = resolveElectronPath();
    if (!electronPath) {
      stopReason = '找不到 Electron（可设置 ERII_ELECTRON_PATH）';
      log('warn', stopReason);
      return;
    }
    if (!existsSync(HELPER_DIR)) {
      stopReason = '缺少 helper 目录';
      log('warn', stopReason);
      return;
    }
    desired = true;
    ready = false;
    stopReason = undefined;
    buffer = '';
    socketBuffer = '';
    outbox = [];
    closeBridge();
    const config = loadConfig();
    // Electron 以 GUI 模式启动时绝不能带 ELECTRON_RUN_AS_NODE（DSH 的 shell 环境里常见），
    // 否则 helper 会被当成纯 Node 跑、require('electron') 直接失败。
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.ERII_HELPER = '1';
    env.ERII_DESKTOP_POSITION = JSON.stringify(config.desktopPosition ?? null);
    env.ERII_DISPLAY = config.display;
    env.ERII_SIZE = String(config.size);
    env.ERII_STATUS_FILE = join(dataDir(), 'desktop-status.json');
    env.ERII_CAPTURE_FILE = join(dataDir(), 'capture.png');
    if (process.env.ERII_CAPTURE_INTERVAL) env.ERII_CAPTURE_INTERVAL = process.env.ERII_CAPTURE_INTERVAL;
    try {
      child = spawn(electronPath, [HELPER_DIR], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });
    } catch (error) {
      stopReason = `启动 Electron 失败：${error instanceof Error ? error.message : String(error)}`;
      log('warn', stopReason);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
        index = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text !== '') {
        hostLog('stderr: ' + text.slice(0, 600));
        log('info', `desktop stderr: ${text.slice(0, 400)}`);
      }
    });
    child.on('error', (error) => {
      hostLog('helper error: ' + error.message);
      log('warn', `桌面 Helper 进程错误：${error.message}`);
    });
    child.on('exit', onExit);
    hostLog(`helper spawn pid=${child.pid} electron=${electronPath} display=${config.display}`);
    log('info', `erii 桌面 Helper 启动：${electronPath}`);
  };

  /** 停止 Helper。 */
  const stop = (reason) => {
    desired = false;
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify({ type: 'quit' }) + '\n');
      } catch {
        /* 已断开 */
      }
    }
    closeBridge();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    if (!child) {
      stopReason = reason;
      return;
    }
    stopReason = reason;
    const target = child;
    child = undefined;
    ready = false;
    try {
      target.stdin?.write(JSON.stringify({ type: 'quit' }) + '\n');
      target.stdin?.end();
    } catch {
      /* 已经退出 */
    }
    setTimeout(() => {
      try {
        target.kill();
      } catch {
        /* 已经退出 */
      }
    }, 500);
  };

  /** 配置变更后同步：该起就起，该停就停。 */
  const sync = (config) => {
    if (disposed) return;
    const wantDesktop =
      Boolean(config.desktopEnabled) && config.display !== 'web' && config.display !== 'none';
    hostLog(`sync display=${config.display} enabled=${String(config.desktopEnabled)} want=${String(wantDesktop)} child=${Boolean(child)}`);
    if (!wantDesktop) {
      if (child) stop('配置关闭了桌面模式');
      else stopReason = '桌面模式关闭';
      return;
    }
    if (child) {
      pushState();
      return;
    }
    restartAttempt = 0;
    start();
  };

  /** 停掉并等待退出（插件卸载时用）。 */
  const dispose = async () => {
    disposed = true;
    desired = false;
    if (restartTimer) clearTimeout(restartTimer);
    if (moveTimer) clearTimeout(moveTimer);
    if (!child) {
      closeBridge();
      return;
    }
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify({ type: 'quit' }) + '\n');
      } catch {
        /* 已断开 */
      }
    }
    closeBridge();
    const target = child;
    child = undefined;
    ready = false;
    try {
      target.stdin?.write(JSON.stringify({ type: 'quit' }) + '\n');
      target.stdin?.end();
    } catch {
      /* 忽略 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          target.kill();
        } catch {
          /* 忽略 */
        }
        resolve();
      }, 800);
      target.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { start, stop, sync, status, capture, dispose, pushState };
}
