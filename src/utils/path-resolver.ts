/**
 * 微信路径解析器
 * 维护各版本微信PC端的数据目录结构映射
 * 支持自动发现：INI配置 → 注册表 → Known Folder → 硬编码降级
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
 * 通过 reg.exe 读取 Windows 注册表值
 * @param key 注册表键路径，如 "HKCU\\Software\\Tencent\\WeChat"
 * @param valueName 值名称
 */
async function queryRegistryValue(key: string, valueName: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  try {
    const { stdout } = await execAsync(`reg query "${key}" /v ${valueName} 2>nul`, {
      encoding: 'utf8',
      windowsHide: true,
    });

    // 解析输出：
    // HKEY_CURRENT_USER\Software\Tencent\WeChat
    //     FileSavePath    REG_SZ    D:\WeChatData
    const pattern = new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)`);
    const match = stdout.match(pattern);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从微信 INI 配置文件读取数据路径（部分版本优先级高于注册表）
 */
async function detectFromIni(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const configDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Tencent',
    'WeChat',
    'All Users',
    'config'
  );

  if (!(await fs.pathExists(configDir))) {
    return null;
  }

  let iniFiles: string[];
  try {
    const entries = await fs.readdir(configDir);
    iniFiles = entries.filter((f) => f.toLowerCase().endsWith('.ini'));
  } catch {
    return null;
  }

  if (iniFiles.length === 0) return null;

  for (const iniFile of iniFiles) {
    const iniPath = path.join(configDir, iniFile);
    try {
      // 微信的 INI 可能是二进制混合格式，先尝试 UTF-8 文本读取
      const content = await fs.readFile(iniPath, 'utf-8');

      // 尝试匹配 WeChat Files 完整路径（如 D:\xxx\WeChat Files）
      const fullPathMatch = content.match(/([A-Z]:\\[^\x00-\x1f*?"<>|]+\\WeChat Files)/i);
      if (fullPathMatch) {
        const candidate = fullPathMatch[1];
        if (await fs.pathExists(candidate)) return candidate;
      }

      // 尝试匹配父目录路径，再拼接 WeChat Files
      const parentMatch = content.match(/([A-Z]:\\[^\x00-\x1f*?"<>|]+)[\r\n\x00]/);
      if (parentMatch) {
        const candidate = path.join(parentMatch[1], 'WeChat Files');
        if (await fs.pathExists(candidate)) return candidate;
      }
    } catch {
      // 读取失败（二进制编码等），继续尝试下一个 INI
      continue;
    }
  }

  return null;
}

/**
 * 从注册表读取 FileSavePath 并组装为 WeChat Files 完整路径
 */
async function detectFromRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const fileSavePath = await queryRegistryValue('HKCU\\Software\\Tencent\\WeChat', 'FileSavePath');
  if (!fileSavePath) return null;

  // FileSavePath 通常是父目录，微信会在其下自动创建 "WeChat Files"
  const withSubDir = path.join(fileSavePath, 'WeChat Files');
  if (await fs.pathExists(withSubDir)) return withSubDir;

  // 少数情况下用户直接指向了 WeChat Files 本身
  if (await fs.pathExists(fileSavePath)) return fileSavePath;

  return null;
}

/**
 * 获取 Windows 真实的「文档」目录（处理 OneDrive 迁移、多语言系统等场景）
 */
async function getDocumentsPath(): Promise<string> {
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), 'Documents');
  }

  // 方法1：通过 PowerShell 查询 Known Folder（最准确）
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "[Environment]::GetFolderPath(\'MyDocuments\')"',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    const docs = stdout.trim();
    if (docs && await fs.pathExists(docs)) return docs;
  } catch {
    // ignore
  }

  // 方法2：环境变量兜底
  if (process.env.USERPROFILE) {
    const docs = path.join(process.env.USERPROFILE, 'Documents');
    if (await fs.pathExists(docs)) return docs;
  }

  // 方法3：最后硬编码
  return path.join(os.homedir(), 'Documents');
}

/**
 * 多盘符兜底搜索（最后手段）
 */
async function searchCommonLocations(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  const candidates = [
    path.join(os.homedir(), 'Documents', 'WeChat Files'),
    path.join(os.homedir(), 'WeChat Files'),
    'D:\\WeChat Files',
    'D:\\Documents\\WeChat Files',
    'E:\\WeChat Files',
    'E:\\Documents\\WeChat Files',
  ];

  for (const candidate of candidates) {
    if (!(await fs.pathExists(candidate))) continue;

    // 确认目录下有 wxid_ 开头的账号文件夹，避免误匹配
    try {
      const entries = await fs.readdir(candidate);
      if (entries.some((e) => e.startsWith('wxid_'))) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 智能检测默认的微信数据目录（Windows）
 * 检测优先级：INI配置 > 注册表 FileSavePath > KnownFolder/Documents > 多盘符搜索
 */
export async function getDefaultWeChatDataPath(): Promise<string> {
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.wechat', 'data');
  }

  // 1. 微信 INI 配置文件（部分版本里优先级高于注册表）
  const iniPath = await detectFromIni();
  if (iniPath) return iniPath;

  // 2. 注册表 FileSavePath
  const regPath = await detectFromRegistry();
  if (regPath) return regPath;

  // 3. 真实 Documents 目录
  const docsPath = await getDocumentsPath();
  const defaultPath = path.join(docsPath, 'WeChat Files');
  if (await fs.pathExists(defaultPath)) return defaultPath;

  // 4. 多盘符兜底搜索
  const searched = await searchCommonLocations();
  if (searched) return searched;

  // 5. 最终 fallback：返回默认路径（即使不存在，让上层报出明确错误）
  return defaultPath;
}

/**
 * 统一入口：解析最终使用的微信数据路径
 * @param customDataPath 用户显式指定的路径（最高优先级）
 */
export async function resolveWeChatDataPath(customDataPath?: string): Promise<string> {
  if (customDataPath) {
    const normalized = path.resolve(customDataPath);
    if (await fs.pathExists(normalized)) {
      return normalized;
    }
    throw new Error(`指定的微信数据目录不存在: ${normalized}`);
  }
  return getDefaultWeChatDataPath();
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
