/**
 * 提取层 (Extractor)
 * 负责自动发现微信PC端数据库文件，校验完整性，按范围筛选目标数据
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import {
  ExtractorConfig,
  ExtractionResult,
  WeChatAccount,
  DatabaseFile,
} from '../types';
import {
  resolveWeChatDataPath,
  scanAccounts,
  locateDatabases,
  isVersionAllowed,
} from '../utils/path-resolver';
import { logger } from '../utils/logger';

export class Extractor {
  private config: ExtractorConfig;

  constructor(config: ExtractorConfig) {
    this.config = config;
  }

  /**
   * 执行提取流程
   */
  async extract(): Promise<ExtractionResult> {
    logger.info('提取层: 开始扫描微信数据目录');

    const dataPath = await resolveWeChatDataPath(this.config.customDataPath);
    logger.debug(`扫描路径: ${dataPath}`);

    // 1. 扫描账号
    const accounts = await scanAccounts(dataPath);
    if (accounts.length === 0) {
      throw new Error(`未在微信数据目录中发现有效账号: ${dataPath}`);
    }
    logger.info(`发现 ${accounts.length} 个微信账号`);

    // 2. 选择目标账号
    const targetAccount = await this.selectAccount(accounts);
    if (!targetAccount.hasDatabases) {
      throw new Error(`账号 ${targetAccount.wxid} 目录下未找到数据库文件`);
    }

    // 3. 定位数据库
    const { msgDatabases, microMsgDb } = await locateDatabases(
      targetAccount.path,
      this.config.startDate,
      this.config.endDate,
    );

    if (msgDatabases.length === 0) {
      throw new Error(`账号 ${targetAccount.wxid} 下未找到 MSG 系列数据库文件`);
    }

    logger.info(`定位到 ${msgDatabases.length} 个 MSG 分片数据库`);

    // 4. 构建数据库文件描述
    const databases: DatabaseFile[] = [];
    for (const dbPath of msgDatabases) {
      const stat = await fs.stat(dbPath);
      const match = path.basename(dbPath).match(/MSG(\d+)\.db/);
      databases.push({
        path: dbPath,
        type: 'MSG',
        shardIndex: match ? parseInt(match[1], 10) : undefined,
        size: stat.size,
        mtime: stat.mtime,
      });
    }

    // MicroMsg.db
    if (await fs.pathExists(microMsgDb)) {
      const stat = await fs.stat(microMsgDb);
      databases.push({
        path: microMsgDb,
        type: 'MicroMsg',
        size: stat.size,
        mtime: stat.mtime,
      });
    }

    // 5. 校验文件可读性
    for (const db of databases) {
      try {
        await fs.access(db.path, fs.constants.R_OK);
      } catch {
        throw new Error(`数据库文件不可读: ${db.path}`);
      }
    }

    // 6. 版本兼容性检查
    const version = await this.detectWeChatVersion(targetAccount.path);
    if (version && this.config.allowedVersions) {
      if (!isVersionAllowed(version, this.config.allowedVersions)) {
        logger.warn(`微信版本 ${version} 不在白名单中，可能存在兼容性问题`);
      }
    }

    const account: WeChatAccount = {
      wxid: targetAccount.wxid,
      dataPath: targetAccount.path,
      databases,
    };

    const result: ExtractionResult = {
      account,
      selectedDatabases: databases.filter((db) => db.type === 'MSG'),
      timeRange: {
        start: this.config.startDate || new Date(0),
        end: this.config.endDate || new Date(),
      },
      meta: {
        scannedAt: new Date(),
        wechatVersion: version,
      },
    };

    logger.info(`提取层完成: 选中账号 ${account.wxid}, ${result.selectedDatabases.length} 个数据库分片`);
    return result;
  }

  /**
   * 多账号场景下选择目标账号
   * 单账号直接返回，多账号抛出错误提示用户指定（CLI场景）
   */
  private async selectAccount(
    accounts: Array<{ wxid: string; path: string; hasDatabases: boolean }>,
  ): Promise<{ wxid: string; path: string; hasDatabases: boolean }> {
    if (accounts.length === 1) {
      return accounts[0];
    }

    // 多账号场景：若用户通过 targetTalkers 隐式指定，尝试推断
    // 否则默认选择第一个有数据库的账号
    const withDb = accounts.filter((a) => a.hasDatabases);
    if (withDb.length === 1) {
      return withDb[0];
    }

    logger.warn(`发现多个账号: ${accounts.map((a) => a.wxid).join(', ')}`);
    logger.warn('默认选择第一个有数据库的账号，如需指定请使用 --account 参数');
    return withDb[0] || accounts[0];
  }

  /**
   * 尝试检测微信版本号
   */
  private async detectWeChatVersion(accountPath: string): Promise<string | undefined> {
    // 尝试从目录结构或日志推断版本
    // V1版本暂返回undefined，由用户手动确认或后续增强
    return undefined;
  }
}
