/**
 * 构建脚本：把共用的渲染核心与立绘内联进两个产物。
 *
 *   src/pet-core.js + src/client.tpl.js + 立绘 → client.js（页内）
 *   src/pet-core.js + src/helper.tpl.js + 立绘 → helper/renderer.js（桌面窗）
 *
 * 立绘三种形态，按优先级自动选：
 *   1. `assets/spritesheet.webp` —— 8×11 帧的 2D 动画图集（当前使用，来自 Codex Pet 社区的绘梨衣宠物包）
 *   2. `art/erii.png` —— 静态 3D 渲染图
 *   3. `art/erii.svg` —— 矢量立绘
 * 图集同时复制进 helper/assets/，桌面窗按本地相对路径加载；页内走宿主 /sprite 路由。
 *
 * 运行：node scripts/build.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const write = (path, content) => {
  writeFileSync(join(ROOT, path), content, 'utf8');
  console.log('wrote', path, String(content.length) + ' bytes');
};

/** 图集：12 列 × 13 行，单帧 128×176。 */
const SPRITE = { cols: 8, rows: 11, width: 192, height: 208 };

let art = '';
let artMode;
let aspect;

if (existsSync(join(ROOT, 'assets', 'spritesheet.webp'))) {
  artMode = 'sprite';
  aspect = SPRITE.height / SPRITE.width;
  // 页内走 /sprite 路由；桌面窗用相对路径，两处都只引用同一个 webp。
  mkdirSync(join(ROOT, 'helper', 'assets'), { recursive: true });
  copyFileSync(join(ROOT, 'assets', 'spritesheet.webp'), join(ROOT, 'helper', 'assets', 'spritesheet.webp'));
} else if (existsSync(join(ROOT, 'art', 'erii.png'))) {
  const buffer = readFileSync(join(ROOT, 'art', 'erii.png'));
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    console.error('art/erii.png 不是合法 PNG。');
    process.exit(1);
  }
  artMode = 'image';
  aspect = buffer.readUInt32BE(20) / buffer.readUInt32BE(16);
  art = 'data:image/png;base64,' + buffer.toString('base64');
} else {
  const svg = read('art/erii.svg');
  if (!svg.includes('<svg')) {
    console.error('缺少 assets/spritesheet.webp、art/erii.png 与合法的 art/erii.svg。');
    process.exit(1);
  }
  artMode = 'svg';
  aspect = 560 / 420;
  art = svg;
}

const core = read('src/pet-core.js');
const route = '/dsh-erii-7351';

const replaceAll = (template, sprite) =>
  template
    .split('__ART__')
    .join(JSON.stringify(art))
    .split('__ART_MODE__')
    .join(JSON.stringify(artMode))
    .split('__ART_ASPECT__')
    .join(String(aspect))
    .split('__SPRITE_COLS__')
    .join(String(SPRITE.cols))
    .split('__SPRITE_ROWS__')
    .join(String(SPRITE.rows))
    .split('__SPRITE_WIDTH__')
    .join(String(SPRITE.width))
    .split('__SPRITE_HEIGHT__')
    .join(String(SPRITE.height))
    .split('__ROUTE__')
    .join(route)
    .split('/*__PET_CORE__*/')
    .join(core);

write('client.js', replaceAll(read('src/client.tpl.js')));
write('helper/renderer.js', replaceAll(read('src/helper.tpl.js')));

console.log('build ok', artMode, 'aspect', aspect.toFixed(3));

