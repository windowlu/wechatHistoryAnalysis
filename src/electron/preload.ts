import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload 脚本
 * 通过 contextBridge 安全地向渲染进程暴露主进程 API
 */

contextBridge.exposeInMainWorld('electronAPI', {
  // 配置管理
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),

  // 目录选择
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),

  // 流水线控制（send，通过事件回调获取结果）
  startAnalysis: (config: unknown) => ipcRenderer.send('pipeline:start', config),
  retryFailed: (failedIds: string[], config: unknown) =>
    ipcRenderer.send('pipeline:retry', failedIds, config),
  cancelAnalysis: () => ipcRenderer.send('pipeline:cancel'),

  // 事件监听
  onLog: (callback: (log: { level: string; message: string }) => void) => {
    const handler = (_: unknown, log: { level: string; message: string }) => callback(log);
    ipcRenderer.on('pipeline:log', handler);
    return () => ipcRenderer.removeListener('pipeline:log', handler);
  },
  onProgress: (callback: (progress: { stage: string; message: string; percent: number }) => void) => {
    const handler = (_: unknown, progress: { stage: string; message: string; percent: number }) =>
      callback(progress);
    ipcRenderer.on('pipeline:progress', handler);
    return () => ipcRenderer.removeListener('pipeline:progress', handler);
  },
  onComplete: (callback: (result: unknown) => void) => {
    const handler = (_: unknown, result: unknown) => callback(result);
    ipcRenderer.on('pipeline:complete', handler);
    return () => ipcRenderer.removeListener('pipeline:complete', handler);
  },
  onError: (callback: (error: string) => void) => {
    const handler = (_: unknown, error: string) => callback(error);
    ipcRenderer.on('pipeline:error', handler);
    return () => ipcRenderer.removeListener('pipeline:error', handler);
  },

  // 文件操作
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
});

// 声明全局类型（供 renderer 的 JS 引用）
declare global {
  interface Window {
    electronAPI: {
      loadConfig: () => Promise<unknown>;
      saveConfig: (config: unknown) => Promise<void>;
      selectDirectory: () => Promise<string | undefined>;
      startAnalysis: (config: unknown) => void;
      retryFailed: (failedIds: string[], config: unknown) => void;
      cancelAnalysis: () => void;
      onLog: (callback: (log: { level: string; message: string }) => void) => () => void;
      onProgress: (
        callback: (progress: { stage: string; message: string; percent: number }) => void,
      ) => () => void;
      onComplete: (callback: (result: unknown) => void) => () => void;
      onError: (callback: (error: string) => void) => () => void;
      openPath: (filePath: string) => Promise<void>;
      showItemInFolder: (filePath: string) => Promise<void>;
    };
  }
}
