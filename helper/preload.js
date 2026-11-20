/**
 * 桌面小窗的预加载桥：只暴露一个极小的 `window.eriiBridge`，
 * 渲染端拿不到 Node / ipcRenderer 本体。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eriiBridge', {
  /** 宿主报到（渲染端加载完成后调用一次）。 */
  hello: () => ipcRenderer.send('erii:hello'),
  /** 发一条消息给宿主。 */
  send: (message) => ipcRenderer.send('erii:to-host', message),
  /** 订阅宿主事件；返回取消函数。 */
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('erii:event', handler);
    return () => ipcRenderer.removeListener('erii:event', handler);
  },
  /** 切换整窗鼠标穿透（命中区外为 true = 穿透）。 */
  interactive: (interactive) => ipcRenderer.send('erii:interactive', Boolean(interactive)),
  /** 拖窗开始 / 结束。 */
  dragStart: () => ipcRenderer.send('erii:drag-start'),
  dragEnd: () => ipcRenderer.send('erii:drag-end'),
  /** 退出桌面小窗。 */
  quit: () => ipcRenderer.send('erii:quit'),
});
