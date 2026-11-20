/**
 * 插件入口（宿主半侧）：挂路由、按配置拉起桌面 Helper。
 *
 * 只依赖 webServer（HTTP 载体）；llm / agentDefaultModel 是可选服务，
 * 没有时宠物照样能点点、说话、吃冰淇淋，只是不能聊天——降级而不是启动失败。
 *
 * @module dsh-erii-pet/src/host/plugin
 */
import { createDesktop } from './desktop.js';
import { createRouter, ROUTE_SEGMENT } from './routes.js';
import { dataDir, hostLog, loadConfig } from './store.js';

export const name = 'dsh-erii-pet';

/** webServer 是硬依赖：没有它页内与桌面两条通道都无从谈起。 */
export const inject = ['webServer'];

/**
 * 插件激活。
 * @param {any} ctx
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      const write = level === 'warn' ? logger?.warn : logger?.info;
      write?.call(logger, `[erii] ${message}`);
    } catch {
      /* 日志不可用不影响功能 */
    }
  };

  dataDir();
  hostLog('plugin apply');
  log('info', '绘梨衣桌宠已加载');

  const desktop = createDesktop({ ctx, log });
  const handle = createRouter({ ctx, log, desktop });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_SEGMENT,
        handler: async (req, res) => {
          // 先读完请求体再进业务层：路由只认 (url, method, text())，不碰 ServerResponse。
          const chunks = [];
          try {
            for await (const chunk of req) chunks.push(chunk);
          } catch {
            /* 客户端中断：下面按空体走 */
          }
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const result = await handle({
            url: req.url ?? '/',
            method: req.method ?? 'GET',
            text: async () => bodyText,
          });
          const buffer = Buffer.isBuffer(result.body) ? result.body : Buffer.from(String(result.body ?? ''), 'utf8');
          try {
            res.statusCode = result.status;
            for (const [key, value] of Object.entries(result.headers ?? {})) res.setHeader(key, value);
            res.end(buffer);
          } catch {
            /* 连接已断：不再写 */
          }
        },
      }),
    'dsh-erii-pet: http routes',
  );

  ctx.effect(() => {
    const config = loadConfig();
    const wantDesktop = Boolean(config.desktopEnabled) && config.display !== 'web' && config.display !== 'none';
    hostLog(`startup display=${config.display} enabled=${String(config.desktopEnabled)} want=${String(wantDesktop)}`);
    if (wantDesktop) desktop.start();
    else log('info', `桌面模式未启用（display=${config.display}, desktopEnabled=${String(config.desktopEnabled)}）`);
    return () => {
      hostLog('plugin dispose');
      void desktop.dispose();
    };
  }, 'dsh-erii-pet: desktop helper');

  // 配置变化统一由路由 / 桌面 Helper 调用 desktop.sync；这里只做一次启动。
}
