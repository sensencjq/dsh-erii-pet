/**
 * 对话与碎碎念的生成（宿主半侧）：把绘梨衣的人设、记忆和用户输入拼成一次请求，
 * 交给 DSH 的 `ctx.llm` 统一抽象层，只取回正文。
 *
 * 人设文本来自 `data/lines.json`，与台词是同一份数据——改人设不需要碰代码。
 * 不负责记忆落盘与气泡展示，那些在 store / routes 里。
 *
 * @module dsh-erii-pet/src/host/llm
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 包根目录：`src/host/llm.js` 往上两级。 */
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 调用身份：适配器据此生成服务商载体（与 dsh-pet 的约定一致，值只需稳定）。 */
const CALL_IDENTITY = 'dsh-erii-pet';

/** 生成超时：聊天 45s、碎碎念 30s，超出就按失败处理，避免悬挂。 */
const CHAT_TIMEOUT_MS = 45_000;
const WHISPER_TIMEOUT_MS = 30_000;

/** 人设缓存：文件很小，读一次即可；用户改文件后重启插件生效。 */
let linesCache;

/**
 * 读 `data/lines.json`。
 * @returns {{persona: string, userName: string, [key: string]: unknown}}
 */
export function lines() {
  if (linesCache !== undefined) return linesCache;
  try {
    linesCache = JSON.parse(readFileSync(PACKAGE_ROOT + 'data/lines.json', 'utf8'));
  } catch {
    linesCache = {
      persona: '你是上杉绘梨衣，说话很短，很轻。',
      userName: 'Sakura',
    };
  }
  return linesCache;
}

/**
 * 取一组台词；缺失或为空时回退到 `chatFail`。
 * @param {string} key
 * @returns {string[]}
 */
export function lineSet(key) {
  const data = lines();
  const value = data[key];
  if (Array.isArray(value) && value.length > 0) return value.filter((item) => typeof item === 'string');
  const fail = data.chatFail;
  return Array.isArray(fail) && fail.length > 0 ? fail : ['……'];
}

/** 当前本地时间的一句话（人设里没有时间，靠这里补上）。 */
function timeLine() {
  const now = new Date();
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const pad = (value) => String(value).padStart(2, '0');
  const hour = now.getHours();
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  return `现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${weekday} ${period}${pad(hour)}:${pad(now.getMinutes())}。`;
}

/**
 * 拼 system 提示词：人设（把 Sakura 换成用户设置的称呼）+ 桌面处境 + 时间。
 * @param {typeof import('./store.js').DEFAULT_CONFIG} config
 * @returns {string}
 */
export function systemPrompt(config) {
  const data = lines();
  const userName = config?.userName || data.userName || 'Sakura';
  const persona = String(data.persona ?? '').split('Sakura').join(userName);
  return [
    persona,
    `你住在${userName}的电脑桌面上，是桌面上的绘梨衣。`,
    timeLine(),
    '【对话方式】回答时先顺着对方这句话回一句（表示听见了），再说你自己的那一句；不要每句都用「不懂」开头，只有真的不明白才说不懂。',
    '【示例】' +
      `${userName}：今天好累 → 绘梨衣：${userName}，累了。／绘梨衣，陪你。` +
      `${userName}：吃冰淇淋吗？ → 绘梨衣：要。／香草味。` +
      `${userName}：你是谁？ → 绘梨衣：绘梨衣。／${userName}的，绘梨衣。` +
      `${userName}：我好难过 → 绘梨衣：……绘梨衣，在。／不走。`,
    '回复要短。不要写动作描写、不要写括号里的动作、不要用颜文字。',
  ].join('\n');
}

/**
 * 取一个可选服务：Cordis 的 `ctx.get(name)` 不会因为没声明 inject 而抛错，
 * 直接 `ctx.name` 在未 inject 时会抛；插件只硬依赖 webServer，这里两种形状都兼容。
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function service(ctx, name) {
  try {
    const fromGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    if (fromGet !== undefined) return fromGet;
  } catch {
    /* 未注入时 get 也可能抛，继续走属性 */
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * 当前会话的模型（用户没选模型时返回 undefined）。
 * @param {any} ctx
 * @returns {{provider: string, model: string} | undefined}
 */
export function currentModel(ctx) {
  try {
    const selection = service(ctx, 'agentDefaultModel')?.currentSelection?.();
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model };
    }
  } catch {
    /* 服务未就绪 */
  }
  return undefined;
}

/** 按需加载 dsh-llm 的消息构造器；缺失时用等价的最小对象兜底。 */
async function messageHelpers() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod.createUserMessage === 'function' && typeof mod.createAssistantMessage === 'function') {
      return { createUserMessage: mod.createUserMessage, createAssistantMessage: mod.createAssistantMessage };
    }
  } catch {
    /* 装的是不提供这些辅助的宿主：走下面的最小对象 */
  }
  return undefined;
}

/**
 * 发一次生成请求，把流收集成一段正文。
 * @param {any} ctx - 宿主上下文（需要 llm 与 agentDefaultModel）
 * @param {{system: string, messages: Array<{role: 'user'|'assistant', text: string}>, timeoutMs: number, preferred?: {provider: string, model: string}}} input
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
export async function generate(ctx, input) {
  const llm = service(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用');
  const preferred = input.preferred;
  const candidates = [];
  if (preferred?.provider && preferred?.model) candidates.push(preferred);
  const active = currentModel(ctx);
  if (active && !candidates.some((item) => item.provider === active.provider && item.model === active.model)) {
    candidates.push(active);
  }
  if (candidates.length === 0) throw new Error('当前会话还没有选择模型');

  const helpers = await messageHelpers();
  let lastError;
  for (const candidate of candidates) {
    try {
      const messages = input.messages.map((message) =>
        message.role === 'user'
          ? helpers
            ? helpers.createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } })
            : { role: 'user', content: [{ type: 'text', text: message.text }] }
          : helpers
            ? helpers.createAssistantMessage({
                content: [{ type: 'text', text: message.text }],
                source: { provider: candidate.provider, model: candidate.model },
              })
            : { role: 'assistant', content: [{ type: 'text', text: message.text }] },
      );
      const options = {
        provider: candidate.provider,
        model: candidate.model,
        sessionId: CALL_IDENTITY,
        system: input.system,
        messages,
        temperature: 0.9,
        signal: AbortSignal.timeout(input.timeoutMs),
      };
      let text = '';
      let finish;
      for await (const chunk of llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          // 个别适配器不发 delta，只发整块：delta 已收到时以 delta 为准，避免重复。
          if (text === '') text = chunk.block.text;
        } else if (chunk.type === 'finish') {
          finish = chunk.reason;
        }
      }
      const trimmed = text.trim();
      if (trimmed !== '') return { text: trimmed, provider: candidate.provider, model: candidate.model };
      lastError = new Error(finish?.kind === 'error' ? finish.failure?.message ?? '模型没有返回正文' : '模型没有返回正文');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('生成失败');
}

/**
 * 生成一句随口话（不针对任何人）。
 * @param {any} ctx
 * @param {typeof import('./store.js').DEFAULT_CONFIG} config
 * @returns {Promise<string>}
 */
export async function whisper(ctx, config) {
  const result = await generate(ctx, {
    system: systemPrompt(config),
    messages: [{ role: 'user', text: '随便说一句此刻心里想的小事，一句就好，不超过14个字。不要问句，不要叫名字。' }],
    timeoutMs: WHISPER_TIMEOUT_MS,
  });
  return result.text;
}

/**
 * 生成一句对话回复。
 *
 * 历史不按 assistant / user 交替回放：不同适配器对 assistant 消息的回放状态要求不一致，
 * 直接塞进请求会偶发 `reading 'replayState'` 一类的适配器错误。这里把历史压成一段
 * 「之前的对话」文本放进 user 消息，稳定、便宜，也足够让她的语气连上。
 *
 * @param {any} ctx
 * @param {typeof import('./store.js').DEFAULT_CONFIG} config
 * @param {string} userText
 * @param {Array<{role: 'user'|'assistant', text: string}>} history
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
export async function chat(ctx, config, userText, history) {
  const userName = config?.userName || 'Sakura';
  const historyText = (history ?? [])
    .map((message) => (message.role === 'user' ? userName : '绘梨衣') + '：' + message.text)
    .join('\n');
  const composed =
    historyText === ''
      ? userText
      : `（之前和${userName}说过的话）\n${historyText}\n（现在${userName}说）\n${userText}`;
  return generate(ctx, {
    system: systemPrompt(config),
    messages: [{ role: 'user', text: composed }],
    timeoutMs: CHAT_TIMEOUT_MS,
  });
}
