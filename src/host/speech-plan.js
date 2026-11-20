/**
 * 台词 → 说话计划。
 *
 * 一句台词如果整段丢给 TTS，得到的是「朗读」：匀速、平调、每次一模一样。
 * 真人说话不是这样——句子之间有呼吸，每句话的语高和快慢都有一点出入，
 * 同一句话第二次说的语气也不一样。这里就做这三件事：
 *
 *  1. 清洗：去掉 markdown / emoji / 网址，把省略号、破折号、波浪号换成停顿；
 *  2. 换气点：在句子中间找一处断开，前后两段各自给一组语速/音调；
 *  3. 配起伏：每段在基础值上叠加「这一次的说法」（三种轮换）+ 按文本哈希固定
 *     的微小抖动，让同一句每次都略有不同，又能稳定命中缓存。
 *
 * 为什么只断成两段：Edge 的 ReadAloud 端点**只接受最多两个 `<prosody>`**，
 * 给三段以上会直接断开连接（实测）。所以这里刻意把段数压在 2。
 *
 * @module dsh-erii-pet/src/host/speech-plan
 */

/** 服务端能接受的最大 `<prosody>` 段数。 */
const MAX_SEGMENTS = 2;

/** 单句超过这个长度才有必要再按逗号找换气点。 */
const LONG_CLAUSE = 14;

/**
 * 三种「同一句的不同说法」：缓慢的、轻一点的、稍微亮一点的。
 * 数值是相对基础语速/音调的偏移，不是绝对值。
 */
const PROFILES = [
  { rate: -2, pitch: 1 },
  { rate: -4, pitch: 0 },
  { rate: 0, pitch: 2 },
];

/** 总语速/音调的上下限：越界就开始像变声器，不像人。 */
const RATE_RANGE = [-16, 3];
const PITCH_RANGE = [-4, 6];

/** 轮换游标：进程启动时随机落点，避免每次都从同一种说法开始。 */
let variantCursor = Math.floor(Math.random() * PROFILES.length);

/** 取下一个「说法」的下标，并推进游标。 */
export function nextVariant() {
  const index = variantCursor;
  variantCursor = (variantCursor + 1) % PROFILES.length;
  return index;
}

/**
 * 清洗文本：只留下该念出来的东西。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSpeech(raw) {
  let text = String(raw ?? '');
  if (text === '') return '';
  // 代码块、行内代码、链接、markdown 记号：不念。
  text = text.replace(/```[\s\S]*?```/g, '，');
  text = text.replace(/`[^`]*`/g, '');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, '');
  text = text.replace(/[*_#>|]+/g, '');
  // emoji 与零宽字符。
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{FEFF}]/gu,
    '',
  );
  // 停顿记法统一成中文标点。
  text = text.replace(/\.{3,}/g, '…');
  text = text.replace(/…{2,}/g, '…');
  text = text.replace(/[~～]+/g, '，');
  text = text.replace(/——+|--+/g, '，');
  // 空白收紧。
  text = text.replace(/[\s\u3000]+/g, ' ').trim();
  text = text.replace(/^[，、]+/, '');
  text = text.replace(/[，、]{2,}/g, '，');
  if (text === '') return '';
  // 结尾必须有标点，否则 TTS 的尾音会突然断掉。
  if (!/[。！？…，；：、!?]$/.test(text)) text += '。';
  return text;
}

/**
 * 断句：先按句末标点切。
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  return text
    .split(/(?<=[。！？…!?；;])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * 在尽量靠近中间的位置把一块文本切成两半，给两个 prosody 段用。
 * @param {string[]} pieces
 * @returns {string[]}
 */
function splitNearMiddle(pieces) {
  if (pieces.length <= 1) return pieces;
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let best = 1;
  let bestGap = Number.POSITIVE_INFINITY;
  let running = 0;
  for (let index = 1; index < pieces.length; index += 1) {
    running += pieces[index - 1].length;
    const gap = Math.abs(running - total / 2);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  }
  return [
    pieces.slice(0, best).join(''),
    pieces.slice(best).join(''),
  ].filter((part) => part.trim() !== '');
}

/**
 * 选换气点：句子多于一句就按句切两半；只有一句但够长，就按逗号切两半。
 * 纯标点的碎片（比如单独一个「……」）会被丢掉——它不产生声音，只占段数。
 * @param {string} text
 * @returns {string[]}
 */
export function splitSpans(text) {
  let spans;
  const sentences = splitSentences(text);
  if (sentences.length >= 2) {
    spans = splitNearMiddle(sentences);
  } else {
    const only = sentences[0] ?? text;
    if (only.length <= LONG_CLAUSE) {
      spans = [only];
    } else {
      const clauses = only.split(/(?<=[，、])/u).filter((part) => part.trim() !== '');
      spans = clauses.length < 2 ? [only] : splitNearMiddle(clauses);
    }
  }
  const spoken = spans.filter((span) => hasSpeech(span));
  return spoken.length > 0 ? spoken.slice(0, MAX_SEGMENTS) : [text];
}

/** 这段文本里有没有能念出来的字（纯标点、纯空白不算）。 */
function hasSpeech(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

/** 解析 `+20%` / `-12%` 这样的语速值。 */
export function parseRate(value, fallback = 0) {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$/.exec(String(value ?? ''));
  return match ? Number(match[1]) : fallback;
}

/** 解析 `+4Hz` / `-2Hz` 这样的音调值。 */
export function parsePitch(value, fallback = 0) {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*Hz\s*$/i.exec(String(value ?? ''));
  return match ? Number(match[1]) : fallback;
}

/** 格式化成 SSML 要的百分比。 */
function formatRate(value) {
  const clamped = Math.max(RATE_RANGE[0], Math.min(RATE_RANGE[1], value));
  const rounded = Math.round(clamped * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}

/** 格式化成 SSML 要的赫兹。 */
function formatPitch(value) {
  const clamped = Math.max(PITCH_RANGE[0], Math.min(PITCH_RANGE[1], value));
  const rounded = Math.round(clamped * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}Hz`;
}

/** FNV-1a：给抖动一个稳定的种子（同一句每次抖动相同，缓存才有意义）。 */
function hash32(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 由种子取一个 [-span, span] 内的稳定抖动。 */
function jitter(seed, span) {
  const unit = ((seed % 1000) / 1000) * 2 - 1;
  return unit * span;
}

/**
 * 生成一句台词的分段计划。
 * @param {{
 *   text: string,
 *   rate?: string,
 *   pitch?: string,
 *   volume?: string,
 *   variant?: number,
 * }} input
 * @returns {{text: string, segments: {text: string, rate: string, pitch: string, volume: string}[], signature: string}}
 */
export function planSpeech(input) {
  const cleaned = normalizeSpeech(input.text);
  if (cleaned === '') throw new Error('没有可念的文本');
  const spans = splitSpans(cleaned);
  if (spans.length === 0) throw new Error('没有可念的文本');

  const baseRate = parseRate(input.rate, -4);
  const basePitch = parsePitch(input.pitch, 2);
  const volume = String(input.volume ?? '+0%');
  const profile = PROFILES[Math.abs(input.variant ?? 0) % PROFILES.length];

  const segments = spans.map((span, index) => {
    const seed = hash32(span);
    const first = index === 0;
    const last = index === spans.length - 1;
    const rate = baseRate + profile.rate + jitter(seed, 2) + (first ? -1 : 0) + (last ? 1.5 : 0);
    const pitch = basePitch + profile.pitch + jitter(seed >>> 3, 1.5) + (last ? -1.5 : 0);
    return { text: span, rate: formatRate(rate), pitch: formatPitch(pitch), volume };
  });

  return {
    text: cleaned,
    segments,
    signature: segments.map((s) => `${s.text}@${s.rate}/${s.pitch}/${s.volume}`).join('|'),
  };
}
