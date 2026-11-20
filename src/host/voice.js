/**
 * 语音合成与缓存（宿主半侧）：把一句台词变成 mp3 字节。
 *
 * 合成前先过一遍 `speech-plan`：清洗文本、切短句、给每句配一点不同的语速和音调，
 * 再交给 Edge 分段念——这样同一句台词不会每次都是一模一样的朗读。
 *
 * 缓存两层：进程内 Map（最近 80 条）+ 磁盘 `voice-cache/<hash>.mp3`。
 * 缓存键里包含分段计划，所以一句话最多留三种「说法」，各缓存一份；
 * 之后轮换播放，既省请求，重复听也不至于完全一致。
 *
 * @module dsh-erii-pet/src/host/voice
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_FORMAT, synthesize } from './edge-tts.js';
import { nextVariant, planSpeech } from './speech-plan.js';
import { voiceCacheDir } from './store.js';

/** 单句上限：再长就截断，避免一次合成拖太久、也避免提示词意外被念出来。 */
const MAX_TEXT_LENGTH = 240;

/** 进程内缓存上限。 */
const MEMORY_CACHE_LIMIT = 80;

/** 两次合成之间的最小间隔：服务端限流（429），并发或连发都会被打回。 */
const MIN_GAP_MS = 900;

/** 串行队列：同一时刻只合成一条。 */
let chain = Promise.resolve();
let lastSynthAt = 0;

/**
 * 排队执行一次合成：串行 + 最小间隔。
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serialized(task) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastSynthAt));
    if (wait > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
      });
    }
    lastSynthAt = Date.now();
    return task();
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** @type {Map<string, Buffer>} */
const memoryCache = new Map();

/** 缓存键：音色 + 输出格式 + 分段签名（文本、断句、每句的语速音调都在里面）。 */
function cacheKeyOf(voice, signature) {
  return createHash('sha256')
    .update([voice, AUDIO_FORMAT, signature].join('\u0000'), 'utf8')
    .digest('hex');
}

/**
 * 合成一句（带缓存）。
 * @param {{text: string, voice: string, rate?: string, pitch?: string, volume?: string}} input
 * @returns {Promise<Buffer>}
 */
export async function speechOf(input) {
  const raw = String(input.text ?? '').trim().slice(0, MAX_TEXT_LENGTH);
  if (raw === '') throw new Error('没有可念的文本');
  const voice = input.voice || 'zh-CN-XiaoyiNeural';
  const plan = planSpeech({
    text: raw,
    rate: input.rate,
    pitch: input.pitch,
    volume: input.volume,
    variant: nextVariant(),
  });
  const key = cacheKeyOf(voice, plan.signature);

  const hit = memoryCache.get(key);
  if (hit) {
    // 命中也算一次使用：挪到 Map 末尾，LRU 语义。
    memoryCache.delete(key);
    memoryCache.set(key, hit);
    return hit;
  }

  const file = join(voiceCacheDir(), key + '.mp3');
  if (existsSync(file)) {
    try {
      const buffer = readFileSync(file);
      if (buffer.length > 0) {
        memoryCache.set(key, buffer);
        return buffer;
      }
    } catch {
      /* 读不了就重新合成 */
    }
  }

  const buffer = await serialized(() => synthesize({ voice, segments: plan.segments }));
  if (buffer.length === 0) throw new Error('语音合成返回空音频');
  try {
    writeFileSync(file, buffer);
  } catch {
    /* 缓存写不进去不影响播放 */
  }
  memoryCache.set(key, buffer);
  if (memoryCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  return buffer;
}

/** 清空进程内缓存（设置改音色后调用，避免旧参数残留）。 */
export function clearSpeechMemory() {
  memoryCache.clear();
}
