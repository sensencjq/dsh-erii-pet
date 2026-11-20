/**
 * 插件 HTTP 路由（宿主半侧）：页内宠物与桌面 Helper 共用的唯一业务出口。
 *
 * 挂在 webServer 的前缀路由上，路径段固定为 `/dsh-erii-7351`。
 * 用 node 原生 handler 而不是 `resource`：`resource` 只接 GET/HEAD，
 * 而配置保存、语音、聊天都是 POST。
 *
 * 返回结构是 `{ status, headers, body }`（body 为 string 或 Buffer），
 * 由挂载处统一写回；业务层不碰 ServerResponse。
 *
 * @module dsh-erii-pet/src/host/routes
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chat, currentModel, lineSet, lines, whisper } from './llm.js';
import { appendMemory, loadConfig, recentHistory, sanitizeConfig, saveConfig } from './store.js';
import { clearSpeechMemory, speechOf } from './voice.js';

/** 路由段：必须与 client 侧拼地址用的常量一致。 */
export const ROUTE_SEGMENT = '/dsh-erii-7351';

/** 图集文件（页内通过 /sprite 取，桌面窗直接读本地文件）。 */
const SPRITE_FILE = fileURLToPath(new URL('../../assets/spritesheet.webp', import.meta.url));
let spriteCache;

/** 允许前端读到的台词组（人设正文不下发）。 */
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

/** 需要读请求体的方法。 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** JSON 结果。 */
function json(data, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(data),
  };
}

/** 文本结果。 */
function text(body, status = 200) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

/** 随机取一条台词。 */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 组装前缀路由处理函数。
 * @param {{
 *   ctx: any,
 *   log: (level: 'info'|'warn', message: string) => void,
 *   desktop: { sync(config: any): void, status(): any, capture(): any },
 * }} deps
 * @returns {(request: {url: string, method: string, text: () => Promise<string>}) => Promise<{status: number, headers: Record<string,string>, body: string|Buffer}>}
 */
export function createRouter(deps) {
  const { ctx, log, desktop } = deps;

  /** 台词包：前端初始化时一次性取走。 */
  const lineBundle = () => {
    const sets = {};
    for (const key of LINE_KEYS) sets[key] = lineSet(key);
    return { userName: lines().userName || 'Sakura', sets };
  };

  return async function handle(request) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(ROUTE_SEGMENT)) return text('not found', 404);
    const rest = url.pathname.slice(ROUTE_SEGMENT.length) || '/';
    const method = request.method.toUpperCase();
    const readBody = async () => {
      if (!BODY_METHODS.has(method)) return {};
      try {
        const raw = await request.text();
        if (raw.trim() === '') return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return undefined;
      }
    };

    try {
      if (method === 'GET' && (rest === '/' || rest === '/health')) {
        return json({ ok: true, name: 'dsh-erii-pet', version: '1.0.0' });
      }

      if (method === 'GET' && rest === '/lines') return json({ ok: true, ...lineBundle() });

      if (method === 'GET' && rest === '/sprite') {
        if (!spriteCache) spriteCache = readFileSync(SPRITE_FILE);
        return {
          status: 200,
          headers: {
            'content-type': 'image/webp',
            'content-length': String(spriteCache.length),
            'cache-control': 'public, max-age=86400',
          },
          body: spriteCache,
        };
      }

      if (method === 'GET' && rest === '/config') {
        const config = loadConfig();
        return json({ ok: true, config, model: Boolean(currentModel(ctx)), desktop: desktop.status() });
      }

      if (method === 'POST' && rest === '/config') {
        const body = await readBody();
        if (body === undefined) return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
        const current = loadConfig();
        const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
        const next = sanitizeConfig({ ...current, ...patch });
        if (patch.voice !== undefined && patch.voice !== current.voice) clearSpeechMemory();
        saveConfig(next);
        desktop.sync(next);
        return json({ ok: true, config: next, desktop: desktop.status() });
      }

      if (method === 'POST' && rest === '/voice') {
        const body = await readBody();
        if (body === undefined) return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
        const config = loadConfig();
        const audio = await speechOf({
          text: String(body.text ?? ''),
          voice: String(body.voice ?? config.voice),
          rate: String(body.rate ?? config.rate),
          pitch: String(body.pitch ?? config.pitch),
          volume: String(body.volume ?? config.ttsVolume),
        });
        return {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(audio.length),
            'cache-control': 'private, max-age=86400',
          },
          body: audio,
        };
      }

      if (method === 'POST' && rest === '/chat') {
        const body = await readBody();
        if (body === undefined) return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
        const config = loadConfig();
        const userText = String(body.text ?? '').trim().slice(0, 500);
        if (userText === '') return json({ ok: false, error: '没有说话内容' }, 400);
        try {
          const result = await chat(ctx, config, userText, recentHistory(config.memoryRounds));
          appendMemory({ role: 'user', text: userText });
          appendMemory({ role: 'assistant', text: result.text });
          return json({ ok: true, text: result.text, provider: result.provider, model: result.model });
        } catch (error) {
          log('warn', `chat failed: ${error instanceof Error ? error.message : String(error)}`);
          return json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            fallback: pick(lineSet('chatFail')),
          });
        }
      }

      if (method === 'POST' && rest === '/whisper') {
        const config = loadConfig();
        try {
          const text = await whisper(ctx, config);
          return json({ ok: true, text });
        } catch (error) {
          log('warn', `whisper failed: ${error instanceof Error ? error.message : String(error)}`);
          return json({ ok: true, text: pick(lineSet('idleWhisper')), fallback: true });
        }
      }

      if (method === 'POST' && rest === '/capture') {
        const body = await readBody();
        return json(desktop.capture(body && typeof body.action === 'string' ? body.action : undefined));
      }

      if (method === 'POST' && rest === '/desktop') {
        const body = await readBody();
        if (body === undefined) return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
        const current = loadConfig();
        const enabled = Boolean(body.enabled);
        const next = sanitizeConfig({ ...current, desktopEnabled: enabled, display: enabled ? 'both' : 'web' });
        saveConfig(next);
        desktop.sync(next);
        return json({ ok: true, config: next, desktop: desktop.status() });
      }

      return json({ ok: false, error: 'unknown route' }, 404);
    } catch (error) {
      log('warn', `route ${method} ${rest} failed: ${error instanceof Error ? error.message : String(error)}`);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}
