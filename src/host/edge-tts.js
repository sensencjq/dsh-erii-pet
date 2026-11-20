/**
 * 自带的 Edge 在线语音合成（lib 级，零第三方依赖）。
 *
 * 为什么不用 npm 包：仓库里能拿到的 `@andresaya/edge-tts` 是 GPL-3.0，
 * 直接依赖没有问题，但把它塞进本插件会让整份产物带上 GPL；这里按公开的
 * Edge ReadAloud 协议自己实现一遍（WebSocket 帧 + DRM 令牌），保持插件自身的
 * 许可证自由。协议与 rany2/edge-tts 一致：speech.config + ssml 两条文本帧，
 * 服务端回二进制音频帧，最后以 `Path:turn.end` 文本帧收尾。
 *
 * 依赖：node:https / node:crypto。有意不引入 ws——宿主主进程里手写帧足够，
 * 也避免插件在安装期再拉一个包。
 *
 * @module dsh-erii-pet/src/host/edge-tts
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

/** 调试开关：设置 ERII_TTS_DEBUG=1 时把帧摘要写到临时日志文件。 */
const DEBUG = process.env.ERII_TTS_DEBUG === '1';
const DEBUG_FILE = process.env.ERII_TTS_DEBUG_FILE ?? '';

/**
 * 调试输出（只在 ERII_TTS_DEBUG=1 时生效）：写文件而不是 stderr，
 * 避免宿主里没人读 stderr 时管道缓冲把进程卡住。
 * @param {...unknown} args
 */
function debugLog(...args) {
  if (!DEBUG) return;
  try {
    appendFileSync(DEBUG_FILE || 'erii-tts-debug.log', args.map(String).join(' ') + '\n');
  } catch {
    /* 调试输出失败不影响合成 */
  }
}

/** Edge ReadAloud 的公开 TrustedClientToken（不是凭据，只用于协议握手）。 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/** 协议版本号：随 Chromium 版本走，服务端只校验格式。 */
const SEC_MS_GEC_VERSION = '1-155.0.4283.45';

/** 合成端点（2026 版 Edge ReadAloud 迁移到 msedgeservices 域名，旧 speech.platform.bing.com 已 403）。 */
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';

/**
 * 输出格式：24kHz 单声道 mp3。
 *
 * 用 96kbps 而不是 48kbps：48k 的编码噪声会让人声发闷、齿音发毛，
 * 听着更像「机器在念」。这份音频只走一次网络、之后都在本地缓存里播，
 * 体积翻倍换更实的音色是划算的。
 */
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

/** 输出格式（缓存键要带上它：换了清晰度，旧缓存就不该再命中）。 */
export const AUDIO_FORMAT = OUTPUT_FORMAT;

/** 握手与收流的整体超时。 */
const TIMEOUT_MS = 20_000;

/** Edge 155 的 UA：服务端会按版本拒绝过旧的客户端。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';

/** 握手头：缺少 Origin / Cookie 时服务端会拒绝升级。 */
const HANDSHAKE_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': USER_AGENT,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** 合成失败：上层据此回结构化错误，不区分上游细节。 */
export class EdgeTtsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EdgeTtsError';
  }
}

/**
 * 算 DRM 令牌 Sec-MS-GEC：Windows 文件时间（100ns 粒度）× 向下取整到 5 分钟，
 * 拼上 TrustedClientToken 后取 SHA-256 大写十六进制。
 * @param {number} [clockSkewMs] - 本机时钟偏差修正（服务端判定过期时重试一次用）。
 * @returns {string}
 */
function secMsGec(clockSkewMs = 0) {
  const unixSeconds = (Date.now() + clockSkewMs) / 1000;
  const windowsSeconds = unixSeconds + 11644473600;
  const rounded = Math.floor(windowsSeconds / 300) * 300;
  const ticks = Math.round(rounded * 1e7);
  return createHash('sha256')
    .update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** 服务端要的 MUID Cookie：32 位大写十六进制随机值。 */
function muidOf() {
  return randomBytes(16).toString('hex').toUpperCase();
}

/** 标准 UUID 请求 id（带连字符；ConnectionId 与 X-RequestId 都用它）。 */
function requestIdOf() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = randomBytes(1)[0];
    const nibble = char === 'x' ? value & 0x0f : (value & 0x03) | 0x08;
    return nibble.toString(16);
  });
}

/** SSML 里的文本转义：只处理会破坏 XML 的三个字符。 */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把一段文本装进 SSML。
 * @param {{text: string, voice: string, rate?: string, pitch?: string, volume?: string, lang?: string}} input
 * @returns {string}
 */
function buildSsml({ text, voice, rate = '+0%', pitch = '+0Hz', volume = '+0%', lang = 'en-US' }) {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(lang)}">` +
    `<voice name="${escapeXml(voice)}">` +
    `<prosody pitch="${escapeXml(pitch)}" rate="${escapeXml(rate)}" volume="${escapeXml(volume)}">` +
    escapeXml(text) +
    '</prosody></voice></speak>'
  );
}

/**
 * 分段 SSML：一句台词拆成若干 `<prosody>` 段，段与段连着念，但每段的语速/音调
 * 可以不同——这是「不像朗读」的关键。
 *
 * 注意：服务端**不接受** `<break>`，也不接受 `mstts:express-as`（发过去直接断开连接），
 * 所以停顿只能靠标点，不能靠 <break/>。
 *
 * @param {{voice: string, segments: {text: string, rate?: string, pitch?: string, volume?: string}[], lang?: string}} input
 * @returns {string}
 */
function buildSegmentsSsml({ voice, segments, lang }) {
  // 语言随音色走：ja-JP-NanamiNeural → ja-JP。给错会让服务端按别的语音规则处理。
  const speechLang = lang || voice.split('-').slice(0, 2).join('-') || 'zh-CN';
  const body = segments
    .map((segment) => {
      const rate = escapeXml(segment.rate ?? '+0%');
      const pitch = escapeXml(segment.pitch ?? '+0Hz');
      const volume = escapeXml(segment.volume ?? '+0%');
      return (
        `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
        escapeXml(segment.text) +
        '</prosody>'
      );
    })
    .join('');
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(speechLang)}">` +
    `<voice name="${escapeXml(voice)}">${body}</voice></speak>`
  );
}

/** speech.config 文本帧：与 Edge 客户端一致，不带 X-RequestId。 */
function configMessage() {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: true, wordBoundaryEnabled: true },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });
  return (
    `X-Timestamp:${new Date().toLocaleString('en-US', { timeZone: 'UTC' })}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`
  );
}

/** ssml 文本帧：Path / X-RequestId / Content-Type / X-Timestamp。 */
function ssmlMessage(id, ssml) {
  return (
    `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${new Date().toLocaleString('en-US', { timeZone: 'UTC' })}\r\n` +
    `Path:ssml\r\n\r\n${ssml}`
  );
}

/**
 * 编码一个客户端→服务端的 WebSocket 帧（必须掩码）。
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * 从服务端帧流里取出一条完整帧；不足一帧时返回 undefined 并保留剩余缓冲。
 * @param {{buffer: Buffer}} state
 * @returns {{fin: boolean, opcode: number, payload: Buffer} | undefined}
 */
function decodeFrame(state) {
  const buffer = state.buffer;
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  let payload = buffer.subarray(offset, offset + length);
  if (mask) {
    const unmasked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i & 3];
    payload = unmasked;
  } else {
    payload = Buffer.from(payload);
  }
  state.buffer = buffer.subarray(offset + length);
  return { fin, opcode, payload };
}

/**
 * 解析 Edge 的二进制音频帧：2 字节头长度（大端）+ 文本头（Path / Content-Type）+ 音频数据。
 *
 * 注意头是**纯文本**的 HTTP 风格键值（`X-RequestId:...\r\nPath:audio\r\n\r\n`），
 * 不是 JSON——早期协议版本才是 JSON，按 JSON 解会把所有音频帧丢掉。
 * @param {Buffer} payload
 * @returns {{path: string, audio: Buffer} | undefined}
 */
function parseAudioFrame(payload) {
  if (payload.length < 2) return undefined;
  const headerLength = payload.readUInt16BE(0);
  if (payload.length < 2 + headerLength) return undefined;
  const header = payload.subarray(2, 2 + headerLength).toString('utf8');
  const path = /Path:([^\r\n]*)/i.exec(header)?.[1]?.trim() ?? '';
  return { path, audio: payload.subarray(2 + headerLength) };
}

/**
 * 一次合成的输入。
 * @typedef {object} SynthInput
 * @property {string} [text]
 * @property {string} voice
 * @property {string} [rate]
 * @property {string} [pitch]
 * @property {string} [volume]
 * @property {{text: string, rate?: string, pitch?: string, volume?: string}[]} [segments]
 *   分段念：给了 segments 就忽略 text/rate/pitch/volume，每段自带语速音调。
 * @property {AbortSignal} [signal]
 */

/**
 * 合成一段 mp3。
 *
 * 服务端会限流（HTTP 429），限流或偶发抽风时还会直接关连接（没有状态码可读）。
 * 这两种都退避重试两次：宠物说话不该因为一次抽风就整句没声。
 *
 * @param {SynthInput} input
 * @returns {Promise<Buffer>}
 */
export async function synthesize(input) {
  const delay = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await synthesizeOnce(input, 0);
    } catch (error) {
      const message = error instanceof EdgeTtsError ? error.message : '';
      const rateLimited = /HTTP 429/.test(message);
      const transient = /服务端关闭了连接|连接提前关闭/.test(message);
      if (attempt >= 2 || (!rateLimited && !transient)) throw error;
      await delay(rateLimited ? 3000 : 900);
    }
  }
}

/**
 * 带时钟偏差重试的一次合成：403/401 时按 +5 分钟重新算令牌再试一次，
 * 覆盖本机时钟比服务端快的常见情况。
 * @param {SynthInput} input
 * @param {number} clockSkewMs
 * @returns {Promise<Buffer>}
 */
async function synthesizeOnce(input, clockSkewMs) {
  const { text, voice, rate, pitch, volume, signal, segments } = input;
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  if (!hasSegments && (typeof text !== 'string' || text.trim() === '')) {
    throw new EdgeTtsError('文本为空');
  }
  if (typeof voice !== 'string' || voice.trim() === '') throw new EdgeTtsError('音色为空');

  const connectId = requestIdOf();
  const url =
    WSS_URL +
    `?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec(clockSkewMs)}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectId}`;

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const chunks = [];
      const state = { buffer: Buffer.alloc(0) };

      const cleanup = () => {
        try {
          socket?.destroy();
        } catch {
          /* 已释放 */
        }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };

      const timeout = setTimeout(() => finish(new EdgeTtsError('语音合成超时')), TIMEOUT_MS);
      timeout.unref?.();
      const onAbort = () => finish(new EdgeTtsError('语音合成已取消'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (error, value) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        finish(error, value);
      };

      const req = httpsRequest(
        url.replace(/^wss:/, 'https:'),
        {
          method: 'GET',
          headers: {
            ...HANDSHAKE_HEADERS,
            Cookie: `MUID=${muidOf()}`,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          },
        },
        (res) => {
          // 走到这里说明服务端没同意升级：读掉响应体，按状态码报错。
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            const code = res.statusCode ?? 0;
            done(new EdgeTtsError(`握手失败 HTTP ${code}${body ? ': ' + body.slice(0, 200) : ''}`));
          });
        },
      );
      req.on('error', (error) => done(new EdgeTtsError(error.message)));
      req.on('upgrade', (res, upgradedSocket) => {
        socket = upgradedSocket;
        if (res.statusCode !== 101) {
          done(new EdgeTtsError(`握手被拒绝 HTTP ${res.statusCode}`));
          return;
        }
        socket.on('data', (data) => {
          state.buffer = Buffer.concat([state.buffer, data]);
          for (;;) {
            const frame = decodeFrame(state);
            if (!frame) break;
            debugLog('frame', 'opcode=' + frame.opcode, 'fin=' + frame.fin, 'len=' + frame.payload.length);
            if (frame.opcode === 0x8) {
              done(new EdgeTtsError('服务端关闭了连接'));
              return;
            }
            if (frame.opcode === 0x9) {
              socket.write(encodeFrame(0xa, frame.payload));
              continue;
            }
            if (frame.opcode === 0x1) {
              const textFrame = frame.payload.toString('utf8');
              debugLog('text', JSON.stringify(textFrame.slice(0, 160)));
              if (textFrame.includes('Path:turn.end')) {
                if (chunks.length === 0) {
                  done(new EdgeTtsError('服务端没有返回音频'));
                  return;
                }
                done(undefined, Buffer.concat(chunks));
                return;
              }
              continue;
            }
            if (frame.opcode === 0x2) {
              const parsed = parseAudioFrame(frame.payload);
              if (DEBUG) {
                const headerLength = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : -1;
                debugLog(
                  'audio-frame headerLen=' + headerLength,
                  'first=' + frame.payload.subarray(0, 24).toString('hex'),
                  'ok=' + Boolean(parsed),
                  'path=' + (parsed ? parsed.path : '-'),
                  'audio=' + (parsed ? parsed.audio.length : -1),
                );
              }
              if (parsed && parsed.audio.length > 0) chunks.push(parsed.audio);
            }
          }
        });
        socket.on('error', (error) => done(new EdgeTtsError(error.message)));
        socket.on('close', () => {
          if (!settled && chunks.length > 0) done(undefined, Buffer.concat(chunks));
          else if (!settled) done(new EdgeTtsError('连接提前关闭'));
        });

        const ssml = hasSegments
          ? buildSegmentsSsml({ voice, segments })
          : buildSsml({ text, voice, rate, pitch, volume });
        socket.write(encodeFrame(0x1, Buffer.from(configMessage(), 'utf8')));
        socket.write(encodeFrame(0x1, Buffer.from(ssmlMessage(connectId, ssml), 'utf8')));
      });
      req.end();
    });
  } catch (error) {
    // 时钟过快时服务端会拒绝令牌：补 5 分钟再试一次（只重试一次，避免死循环）。
    if (clockSkewMs === 0 && error instanceof EdgeTtsError && /40[13]/.test(error.message)) {
      return synthesizeOnce(input, 5 * 60 * 1000);
    }
    throw error instanceof EdgeTtsError ? error : new EdgeTtsError(error?.message ?? String(error));
  }
}

/**
 * 列出一部分常用音色（离线清单；真正的可用音色以 Edge 服务为准）。
 * 这里只收录本插件设置页展示的候选，不追求完整。
 */
export const VOICE_PRESETS = [
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 清亮少女（默认）' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔邻家' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北 · 软糯东北腔' },
  { id: 'ja-JP-NanamiNeural', name: '七海 · 日语少女' },
  { id: 'ja-JP-AoiNeural', name: '葵 · 日语清冷' },
];
