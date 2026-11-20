/**
 * 宿主半侧的本地存储：配置、聊天记忆、语音缓存目录。
 *
 * 全部落在 `DSH_HOME/erii-pet/` 下（`DSH_HOME` 缺省时用 `~/.dsh`），
 * 不写 profile、不碰插件包目录——安装目录是只读的发布物，用户数据必须分开。
 *
 * @module dsh-erii-pet/src/host/store
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH 主目录。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/** 本插件的数据目录。 */
export function dataDir() {
  const dir = join(dshHome(), 'erii-pet');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 配置文件的绝对路径。 */
export function configPath() {
  return join(dataDir(), 'config.json');
}

/** 记忆文件的绝对路径。 */
export function memoryPath() {
  return join(dataDir(), 'memory.json');
}

/** 语音缓存目录。 */
export function voiceCacheDir() {
  const dir = join(dataDir(), 'voice-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 追加一行宿主诊断日志：没有控制台时，这是排查「桌面窗为什么没起来」的唯一线索。
 * @param {string} message
 */
export function hostLog(message) {
  try {
    appendFileSync(join(dataDir(), 'host.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响功能 */
  }
}

/** 默认配置。字段少而稳定：所有值都能在设置面板里改，改完立即生效。 */
export const DEFAULT_CONFIG = {
  /** 版本号：将来迁移配置格式时用。 */
  version: 1,
  /** 显示位置：web 只在 DSH 页内，desktop 只在桌面，both 两边都在，none 都藏起来。 */
  display: 'both',
  /** 桌面模式是否启用（拉一个透明 Electron 小窗）。 */
  desktopEnabled: true,
  /** 声音总开关。 */
  voiceEnabled: true,
  /** Edge TTS 音色。晓伊偏少女清亮，晓晓更自然温柔。 */
  voice: 'zh-CN-XiaoyiNeural',
  /**
   * 语速 / 音调 / 音量（SSML 百分比与赫兹）。
   *
   * 这三个是「基准值」，每句还会在它上面叠加一点点起伏（见 speech-plan.js）。
   * 想让她像真人：语速别压得太狠（-12% 会变成念稿），音调略微提一点点，
   * 音量交给播放音量去调，这里不要压低，压低只会让声音发闷、更像机器。
   */
  rate: '-4%',
  pitch: '+2Hz',
  ttsVolume: '+0%',
  /** 播放响度 0~1。 */
  volume: 0.9,
  /** 宠物宽度（px）；高度按立绘比例。 */
  size: 240,
  /** 主人在故事里的称呼（绘梨衣会这样叫你）。 */
  userName: 'Sakura',
  /** 是否让她自言自语。 */
  whisperEnabled: true,
  /** 自言自语周期（秒），实际会随机浮动。 */
  whisperIntervalSec: 240,
  /** 睡觉后是否不再自言自语。/ 闲置多久（分钟）自动犯困；0 = 不自动睡。 */
  sleepAfterMin: 45,
  /** 聊天携带的历史轮数。 */
  memoryRounds: 8,
  /** 页内位置（相对视口右下角：x 为距左，y 为距顶；null = 默认右下）。 */
  position: null,
  /** 桌面小窗位置（屏幕坐标；null = 右下角）。 */
  desktopPosition: null,
};

/**
 * 只接受配置里认识的字段，并把类型收紧到可用范围。
 * 未知字段直接丢弃：配置面板写入的内容也要走这里。
 * @param {Record<string, unknown>} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function sanitizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };  const source = raw && typeof raw === 'object' ? raw : {};
  const bool = (key) => {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  };
  const string = (key, maxLength = 120) => {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.slice(0, maxLength);
  };
  const number = (key, min, max) => {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.min(max, Math.max(min, value));
  };
  if (['web', 'desktop', 'both', 'none'].includes(source.display)) out.display = source.display;
  bool('desktopEnabled');
  bool('voiceEnabled');
  bool('whisperEnabled');
  string('voice', 80);
  string('rate', 8);
  string('pitch', 8);
  string('ttsVolume', 8);
  string('userName', 24);
  number('volume', 0, 1);
  number('size', 120, 420);
  number('whisperIntervalSec', 60, 3600);
  number('sleepAfterMin', 0, 600);
  number('memoryRounds', 0, 40);
  const vector = (key) => {
    const value = source[key];
    if (value && typeof value === 'object') {
      const x = Number(value.x);
      const y = Number(value.y);
      if (Number.isFinite(x) && Number.isFinite(y)) out[key] = { x: Math.round(x), y: Math.round(y) };
    }
  };
  vector('position');
  vector('desktopPosition');
  return out;
}

/**
 * v1 时代的语音默认值（-12% / -2Hz / -6%）：那组参数听着像念稿。
 * 老配置如果三项都还是原样，说明用户从没调过，跟着新默认一起升级；
 * 只要用户动过其中任何一项，就完全不碰。
 */
const LEGACY_VOICE_DEFAULTS = { rate: '-12%', pitch: '-2Hz', ttsVolume: '-6%' };

/**
 * 配置迁移：目前只处理语音默认值升级。
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {typeof DEFAULT_CONFIG}
 */
function migrateConfig(config) {
  const untouched =
    config.rate === LEGACY_VOICE_DEFAULTS.rate &&
    config.pitch === LEGACY_VOICE_DEFAULTS.pitch &&
    config.ttsVolume === LEGACY_VOICE_DEFAULTS.ttsVolume;
  if (!untouched) return config;
  return {
    ...config,
    rate: DEFAULT_CONFIG.rate,
    pitch: DEFAULT_CONFIG.pitch,
    ttsVolume: DEFAULT_CONFIG.ttsVolume,
  };
}

/**
 * 读配置；文件不存在或损坏时回默认，并把损坏文件改名留证。
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig() {
  const file = configPath();
  try {
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const sanitized = sanitizeConfig(parsed);
    const migrated = migrateConfig(sanitized);
    if (migrated !== sanitized) {
      try {
        saveConfig(migrated);
      } catch {
        /* 迁移写不进去也不影响本次运行 */
      }
    }
    return migrated;
  } catch {
    try {
      renameSync(file, file + '.broken-' + Date.now());
    } catch {
      /* 改不了名就忽略，不改写用户文件 */
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 原子写配置（先写临时文件再 rename，避免半截 JSON）。
 * @param {typeof DEFAULT_CONFIG} config
 */
export function saveConfig(config) {
  const file = configPath();
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * 读聊天记忆。
 * @returns {{messages: Array<{role: 'user'|'assistant', text: string, ts: number}>}}
 */
export function loadMemory() {
  const file = memoryPath();
  try {
    if (!existsSync(file)) return { messages: [] };
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const messages = Array.isArray(parsed?.messages)
      ? parsed.messages
          .filter(
            (item) =>
              item &&
              (item.role === 'user' || item.role === 'assistant') &&
              typeof item.text === 'string' &&
              item.text.trim() !== '',
          )
          .map((item) => ({
            role: item.role,
            text: item.text.slice(0, 2000),
            ts: Number.isFinite(item.ts) ? item.ts : Date.now(),
          }))
      : [];
    return { messages };
  } catch {
    return { messages: [] };
  }
}

/**
 * 追加一轮对话并落盘（只保留最近 200 条，避免文件无限增长）。
 * @param {{role: 'user'|'assistant', text: string}} message
 */
export function appendMemory(message) {
  const memory = loadMemory();
  memory.messages.push({ ...message, ts: Date.now() });
  if (memory.messages.length > 200) memory.messages = memory.messages.slice(-200);
  const file = memoryPath();
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(memory, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * 取最近 N 轮（一问一答算一轮）用于提示词上下文。
 * @param {number} rounds
 * @returns {Array<{role: 'user'|'assistant', text: string}>}
 */
export function recentHistory(rounds) {
  const messages = loadMemory().messages;
  const keep = Math.max(0, Math.floor(rounds)) * 2;
  return messages.slice(-keep).map(({ role, text }) => ({ role, text }));
}

