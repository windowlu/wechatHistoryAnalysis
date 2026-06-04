/**
 * 微信路径解析器
 * 维护各版本微信PC端的数据目录结构映射
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';

/** 微信版本路径规则 */
interface VersionPathRule {
  /** 版本范围，如 "3.9.x" */
  versionPattern: string;
  /** 数据目录模板（相对用户目录） */
  dataPathTemplate: string;
  /** 数据库文件命名规则 */
  dbNaming: {
    msgPrefix: string;
    msgShardCount: number;
    microMsg: string;
  };
}

/** 已知的微信版本路径规则 */
const KNOWN_PATH_RULES: VersionPathRule[] = [
  {
    versionPattern: '3.9.x',
    dataPathTemplate: 'Documents\\WeChat Files',
    dbNaming: {
      msgPrefix: 'MSG',
      msgShardCount: 10,
      microMsg: 'MicroMsg.db',
    },
  },
  {
    versionPattern: '3.8.x',
    dataPathTemplate: 'Documents\\WeChat Files',
    dbNaming: {
      msgPrefix: 'MSG',
      msgShardCount: 10,
      microMsg: 'MicroMsg.db',
    },
  },
];

/**
 * 获取默认的微信数据目录
 */
export function getDefaultWeChatDataPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, 'Documents', 'WeChat Files');
  }
  // macOS / Linux 下无微信PC端，返回模拟路径用于测试
  return path.join(home, '.wechat', 'data');
}

/**
 * 扫描微信数据目录下的账号
 * @param dataPath 微信数据根目录
 */
export async function scanAccounts(dataPath: string): Promise<Array<{
  wxid: string;
  path: string;
  hasDatabases: boolean;
}>> {
  if (!(await fs.pathExists(dataPath))) {
    return [];
  }

  const entries = await fs.readdir(dataPath, { withFileTypes: true });
  const accounts: Array<{ wxid: string; path: string; hasDatabases: boolean }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // 微信账号文件夹以 wxid_ 开头
    if (name.startsWith('wxid_')) {
      const accountPath = path.join(dataPath, name);
      const dbPath = path.join(accountPath, 'Msg');
      const hasDatabases = await fs.pathExists(dbPath);
      accounts.push({ wxid: name, path: accountPath, hasDatabases });
    }
  }

  return accounts;
}

/**
 * 定位指定账号下的数据库文件
 * @param accountPath 账号目录
 * @param startDate 起始日期（可选，用于筛选分片）
 * @param endDate 结束日期（可选，用于筛选分片）
 */
export async function locateDatabases(
  accountPath: string,
  startDate?: Date,
  endDate?: Date,
): Promise<{
  msgDatabases: string[];
  microMsgDb: string;
}> {
  const msgDir = path.join(accountPath, 'Msg');
  const msgDatabases: string[] = [];
  const microMsgDb = path.join(msgDir, 'MicroMsg.db');

  // MSG0.db ~ MSG9.db
  for (let i = 0; i < 10; i++) {
    const dbPath = path.join(msgDir, `MSG${i}.db`);
    if (await fs.pathExists(dbPath)) {
      // TODO: 根据分片时间范围筛选
      // 当前版本暂加载所有分片，由下游时间范围过滤
      msgDatabases.push(dbPath);
    }
  }

  return { msgDatabases, microMsgDb };
}

/**
 * 检查微信版本是否在白名单中
 * @param version 检测到的版本号
 * @param whitelist 白名单
 */
export function isVersionAllowed(version: string, whitelist?: string[]): boolean {
  if (!whitelist || whitelist.length === 0) return true;
  return whitelist.some((pattern) => {
    const regex = new RegExp('^' + pattern.replace(/x/g, '\\d+').replace(/\./g, '\\.') + '$');
    return regex.test(version);
  });
}
