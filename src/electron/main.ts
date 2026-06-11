import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import { AnalysisPipeline } from '../pipeline';
import { logger } from '../utils/logger';
import { PipelineConfig } from '../types';

let mainWindow: BrowserWindow | null = null;
let activePipeline: AnalysisPipeline | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: '微信客户识别系统',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 允许 preload 加载本地文件
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发时按 F12 可打开开发者工具
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await ensureUserConfig();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * 首次运行时，将打包内置的 config.json 复制到用户数据目录，
 * 保证便携版/发行版启动时已经带有默认配置（含内置 API Key）。
 */
async function ensureUserConfig(): Promise<void> {
  const userConfigPath = path.join(app.getPath('userData'), 'config.json');
  if (await fs.pathExists(userConfigPath)) return;

  const bundledConfigPath = await findBundledConfigPath();
  if (!bundledConfigPath) {
    logger.warn('未找到内置 config.json，将使用空配置启动');
    return;
  }

  try {
    await fs.ensureDir(app.getPath('userData'));
    await fs.copyFile(bundledConfigPath, userConfigPath);
    logger.info('已复制内置配置到用户数据目录', { userConfigPath });
  } catch (error) {
    logger.error('复制内置配置失败', { error });
  }
}

/** 在开发/生产不同布局下定位打包内置的 config.json */
async function findBundledConfigPath(): Promise<string | null> {
  const candidates = [
    // 开发环境：dist/electron/main.js 的 __dirname 上一级再上一级为项目根目录
    path.join(__dirname, '..', '..', 'config.json'),
    // 生产环境（asar/unpacked）：config.json 与 electron 目录同级
    path.join(__dirname, '..', 'config.json'),
    // 生产环境备选
    path.join(process.resourcesPath, 'app.asar', 'config.json'),
    path.join(process.resourcesPath, 'app', 'config.json'),
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) return candidate;
  }
  return null;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ═══════════════════════════════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════════════════════════════

/** 配置管理 */
ipcMain.handle('config:load', async () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  if (await fs.pathExists(configPath)) {
    try {
      return await fs.readJson(configPath);
    } catch {
      return null;
    }
  }
  return null;
});

ipcMain.handle('config:save', async (_, config: unknown) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  await fs.ensureDir(app.getPath('userData'));
  await fs.writeJson(configPath, config, { spaces: 2 });
});

/** 目录选择 */
ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

/** 流水线控制 */
ipcMain.on('pipeline:start', async (_, config: unknown) => {
  if (!mainWindow) return;

  try {
    // 注册 logger transport，将日志实时推送到渲染进程
    logger.clearTransports();
    logger.addTransport((level, message) => {
      mainWindow?.webContents.send('pipeline:log', { level, message });
    });

    // 构建并启动流水线
    const pipelineConfig = config as PipelineConfig;
    const pipeline = new AnalysisPipeline(pipelineConfig);
    activePipeline = pipeline;

    // 转发进度事件
    pipeline.on('stage', (stage) => {
      mainWindow?.webContents.send('pipeline:progress', stage);
    });

    pipeline.on('complete', (result) => {
      mainWindow?.webContents.send('pipeline:complete', result);
    });

    pipeline.on('error', (error: string) => {
      mainWindow?.webContents.send('pipeline:error', error);
    });

    // 执行流水线
    const result = await pipeline.run();

    // 兜底：如果事件未触发（理论上不会发生），手动发送
    if (result.success) {
      mainWindow?.webContents.send('pipeline:complete', result);
    } else {
      mainWindow?.webContents.send('pipeline:error', result.error || '未知错误');
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send('pipeline:error', errorMsg);
  } finally {
    activePipeline = null;
    logger.clearTransports();
  }
});

ipcMain.on('pipeline:retry', async (_, failedIds: string[], config: unknown) => {
  if (!mainWindow) return;

  try {
    logger.clearTransports();
    logger.addTransport((level, message) => {
      mainWindow?.webContents.send('pipeline:log', { level, message });
    });

    const pipelineConfig = config as PipelineConfig;
    const pipeline = new AnalysisPipeline(pipelineConfig);
    activePipeline = pipeline;

    pipeline.on('stage', (stage) => {
      mainWindow?.webContents.send('pipeline:progress', stage);
    });

    // 构造一个模拟的 previousResult，只包含必要字段
    const previousResult = {
      success: false,
      stages: {},
      stats: {
        startTime: new Date(),
        endTime: new Date(),
        durationMs: 0,
      },
    };

    const result = await pipeline.retryFailed(failedIds, previousResult as any);

    if (result.success) {
      mainWindow?.webContents.send('pipeline:complete', result);
    } else {
      mainWindow?.webContents.send('pipeline:error', result.error || '重试失败');
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send('pipeline:error', errorMsg);
  } finally {
    activePipeline = null;
    logger.clearTransports();
  }
});

ipcMain.on('pipeline:cancel', () => {
  // TODO: 实现真正的取消逻辑
  // 当前版本仅重置状态，后台任务会继续执行但前端不再接收更新
  activePipeline = null;
  logger.clearTransports();
});

/** 文件/目录操作 */
ipcMain.handle('shell:openPath', async (_, filePath: string) => {
  await shell.openPath(filePath);
});

ipcMain.handle('shell:showItemInFolder', async (_, filePath: string) => {
  shell.showItemInFolder(filePath);
});
