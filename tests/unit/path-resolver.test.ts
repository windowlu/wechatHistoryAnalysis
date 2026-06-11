/**
 * 微信路径解析器单元测试
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import {
  resolveWeChatDataPath,
  getDefaultWeChatDataPath,
  scanAccounts,
} from '../../src/utils/path-resolver';

jest.mock('os', () => ({
  homedir: jest.fn(),
  platform: jest.fn(),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn(),
  access: jest.fn(),
  stat: jest.fn(),
  constants: { R_OK: 4 },
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedOs = os as any;
const mockedFs = fs as any;
const mockedExec = exec as jest.MockedFunction<typeof exec>;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** 统一路径分隔符，用于跨平台 mock 比较 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function mockExecStdout(stdout: string) {
  mockedExec.mockImplementation((command: string, options?: any, callback?: any) => {
    if (typeof options === 'function') {
      callback = options;
    }
    const child = { stdout: '', stderr: '', on: jest.fn(), kill: jest.fn() } as any;
    process.nextTick(() => callback?.(null, { stdout, stderr: '' }));
    return child;
  });
}

describe('path-resolver on Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
    jest.clearAllMocks();
    mockedOs.homedir.mockReturnValue('C:\\Users\\TestUser');
    // 默认让 exec 安全返回空，避免某个测试未覆盖 exec 时 promisify 挂起
    mockedExec.mockImplementation((command: string, options?: any, callback?: any) => {
      if (typeof options === 'function') callback = options;
      const child = { stdout: '', stderr: '', on: jest.fn(), kill: jest.fn() } as any;
      process.nextTick(() => callback?.(null, { stdout: '', stderr: '' }));
      return child;
    });
  });

  afterAll(() => {
    setPlatform(process.platform);
  });

  describe('resolveWeChatDataPath', () => {
    it('优先使用用户显式指定的路径', async () => {
      mockedFs.pathExists.mockResolvedValue(true);
      const result = await resolveWeChatDataPath('D:\\xwechat_files');
      expect(result).toBe(path.resolve('D:\\xwechat_files'));
    });

    it('指定路径不存在时抛出错误', async () => {
      mockedFs.pathExists.mockResolvedValue(false);
      await expect(resolveWeChatDataPath('D:\\not_exist')).rejects.toThrow('指定的微信数据目录不存在');
    });
  });

  describe('getDefaultWeChatDataPath', () => {
    it('通过 INI 配置识别自定义目录名', async () => {
      const configDir = 'C:\\Users\\TestUser\\AppData\\Roaming\\Tencent\\WeChat\\All Users\\config';
      mockedFs.pathExists.mockImplementation(async (p: string) => {
        const np = normalizePath(p);
        return np === normalizePath(configDir) || np === normalizePath('D:\\xwechat_files');
      });
      mockedFs.readdir.mockImplementation(async (p: string, options?: any) => {
        const np = normalizePath(p);
        if (np === normalizePath(configDir)) return ['3ebffe94.ini'];
        if (np === normalizePath('D:\\xwechat_files')) return [{ isDirectory: () => true, name: 'wxid_abc123' }];
        return [];
      });
      mockedFs.readFile.mockResolvedValue(Buffer.from('D:\\xwechat_files'));

      const result = await getDefaultWeChatDataPath();
      expect(result).toBe('D:\\xwechat_files');
    });

    it('通过注册表 FileSavePath 识别自定义目录名', async () => {
      mockExecStdout('HKEY_CURRENT_USER\\Software\\Tencent\\WeChat\r\n    FileSavePath    REG_SZ    D:\\xwechat_files');
      mockedFs.pathExists.mockImplementation(async (p: string) => {
        const np = normalizePath(p);
        if (np === normalizePath('D:\\xwechat_files\\WeChat Files')) return false;
        return np === normalizePath('D:\\xwechat_files');
      });
      mockedFs.readdir.mockImplementation(async (p: string, options?: any) => {
        const np = normalizePath(p);
        if (np === normalizePath('D:\\xwechat_files')) return [{ isDirectory: () => true, name: 'wxid_abc123' }];
        return [];
      });

      const result = await getDefaultWeChatDataPath();
      expect(result).toBe('D:\\xwechat_files');
    });

    it('兜底扫描识别 D:\\xwechat_files', async () => {
      mockedExec.mockImplementation((command: string, options?: any, callback?: any) => {
        if (typeof options === 'function') callback = options;
        const stdout = command.includes('wmic') ? 'Node\r\nD:\r\n' : '';
        const child = { stdout: '', stderr: '', on: jest.fn(), kill: jest.fn() } as any;
        process.nextTick(() => callback?.(null, { stdout, stderr: '' }));
        return child;
      });
      mockedFs.pathExists.mockImplementation(async (p: string) => {
        return normalizePath(p) === normalizePath('D:\\xwechat_files');
      });
      mockedFs.readdir.mockImplementation(async (p: string, options?: any) => {
        const np = normalizePath(p);
        if (np === normalizePath('D:\\')) return [{ isDirectory: () => true, name: 'xwechat_files' }];
        if (np === normalizePath('D:\\xwechat_files')) return [{ isDirectory: () => true, name: 'wxid_abc123' }];
        return [];
      });

      const result = await getDefaultWeChatDataPath();
      expect(result).toBe('D:\\xwechat_files');
    });
  });

  describe('scanAccounts', () => {
    it('识别 wxid_ 开头的账号文件夹', async () => {
      mockedFs.pathExists.mockResolvedValue(true);
      mockedFs.readdir.mockResolvedValue([
        { isDirectory: () => true, name: 'wxid_abc' },
        { isDirectory: () => true, name: 'wxid_def' },
        { isDirectory: () => false, name: 'not_a_dir' },
      ]);

      const accounts = await scanAccounts('D:\\xwechat_files');
      expect(accounts).toHaveLength(2);
      expect(accounts[0].wxid).toBe('wxid_abc');
      expect(accounts.every((a) => a.hasDatabases)).toBe(true);
    });
  });
});
