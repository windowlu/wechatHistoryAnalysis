/**
 * 解密层 (Decryptor)
 * 负责获取SQLCipher密钥，批量解密微信数据库，输出原始消息流
 * 以独立子进程方式运行，与主进程隔离
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn, SpawnOptions } from 'child_process';
import { DecryptorConfig, DecryptionResult, RawMessage } from '../types';
import { logger } from '../utils/logger';
import { writeJsonlStream } from '../utils/stream-helper';

export class Decryptor {
  private config: DecryptorConfig;

  constructor(config: DecryptorConfig) {
    this.config = config;
  }

  /**
   * 执行批量解密
   * @param dbPaths 待解密的数据库文件路径列表
   * @param microMsgDbPath 联系人数据库路径（可选，用于辅助密钥提取）
   */
  async decrypt(dbPaths: string[], microMsgDbPath?: string): Promise<DecryptionResult> {
    logger.info('解密层: 开始批量解密');
    const startTime = Date.now();

    await fs.ensureDir(this.config.outputDir);

    // 1. 获取解密密钥
    const key = await this.resolveKey(microMsgDbPath);
    if (!key) {
      throw new Error('无法获取数据库解密密钥，请确保微信已登录或提供手动密钥');
    }
    logger.info('密钥获取成功');

    // 2. 逐库解密
    const outputPath = path.join(this.config.outputDir, 'raw_messages.jsonl');
    const allMessages: RawMessage[] = [];
    const shardStats: Array<{ dbPath: string; messageCount: number }> = [];
    const failedShards: string[] = [];

    for (const dbPath of dbPaths) {
      try {
        logger.debug(`解密数据库: ${path.basename(dbPath)}`);
        const messages = await this.decryptSingleDb(dbPath, key);
        allMessages.push(...messages);
        shardStats.push({ dbPath, messageCount: messages.length });
        logger.info(`${path.basename(dbPath)}: ${messages.length} 条消息`);
      } catch (err) {
        logger.error(`解密失败: ${dbPath}`, { error: String(err) });
        failedShards.push(dbPath);
      }
    }

    // 3. 按时间排序并写入JSONL
    allMessages.sort((a, b) => a.createTime - b.createTime);
    await writeJsonlStream(outputPath, allMessages);

    const durationMs = Date.now() - startTime;
    logger.info(`解密层完成: ${allMessages.length} 条消息, 耗时 ${durationMs}ms`);

    return {
      outputPath,
      totalMessages: allMessages.length,
      shardStats,
      durationMs,
      failedShards,
    };
  }

  /**
   * 解析解密密钥
   * 按策略优先级尝试：内存提取 > 缓存文件 > 手动输入
   */
  private async resolveKey(microMsgDbPath?: string): Promise<string | null> {
    switch (this.config.strategy) {
      case 'memory':
        return this.extractKeyFromMemory();
      case 'cache':
        return this.extractKeyFromCache();
      case 'manual':
        return this.config.manualKey || null;
      default:
        // 自动策略：依次尝试
        let key = await this.extractKeyFromMemory();
        if (key) return key;
        key = await this.extractKeyFromCache();
        if (key) return key;
        return this.config.manualKey || null;
    }
  }

  /**
   * 从微信进程内存中提取密钥
   * 实际实现需调用外部工具（如Go编写的内存读取器）
   */
  private async extractKeyFromMemory(): Promise<string | null> {
    logger.debug('尝试从内存中提取密钥');

    // 调用外部密钥提取工具
    const toolPath = this.config.decryptToolPath;
    if (!(await fs.pathExists(toolPath))) {
      logger.warn(`密钥提取工具不存在: ${toolPath}`);
      return null;
    }

    try {
      const key = await this.runKeyExtractor(toolPath, 'memory');
      return key;
    } catch (err) {
      logger.warn('内存提取密钥失败', { error: String(err) });
      return null;
    }
  }

  /**
   * 从本地缓存中提取密钥
   */
  private async extractKeyFromCache(): Promise<string | null> {
    logger.debug('尝试从本地缓存中提取密钥');

    const toolPath = this.config.decryptToolPath;
    if (!(await fs.pathExists(toolPath))) {
      return null;
    }

    try {
      const key = await this.runKeyExtractor(toolPath, 'cache');
      return key;
    } catch (err) {
      logger.warn('缓存提取密钥失败', { error: String(err) });
      return null;
    }
  }

  /**
   * 运行密钥提取子进程
   */
  private runKeyExtractor(toolPath: string, mode: 'memory' | 'cache'): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const proc = spawn(toolPath, ['--mode', mode, '--key-only'], {
        timeout: 30000,
        windowsHide: true,
      } as SpawnOptions);

      let stdout = '';
      let stderr = '';

      (proc.stdout as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      (proc.stderr as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(stderr || `进程退出码 ${code}`));
          return;
        }
        const key = stdout.trim();
        resolve(key || null);
      });

      proc.on('error', reject);
    });
  }

  /**
   * 解密单个数据库文件
   * 调用外部解密工具，以子进程方式执行
   */
  private async decryptSingleDb(dbPath: string, key: string): Promise<RawMessage[]> {
    return new Promise((resolve, reject) => {
      const toolPath = this.config.decryptToolPath;
      const args = [
        '--mode', 'decrypt',
        '--db', dbPath,
        '--key', key,
        '--format', 'json',
      ];

      const proc = spawn(toolPath, args, {
        timeout: 120000,
        windowsHide: true,
      } as SpawnOptions);

      let stdout = '';
      let stderr = '';

      (proc.stdout as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      (proc.stderr as NodeJS.ReadableStream).on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(stderr || `解密进程退出码 ${code}`));
          return;
        }

        try {
          const messages = this.parseDecryptOutput(stdout);
          resolve(messages);
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * 解析解密工具的JSON输出
   */
  private parseDecryptOutput(output: string): RawMessage[] {
    const messages: RawMessage[] = [];
    const lines = output.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        messages.push({
          msgId: String(obj.msgId || obj.MsgId || obj.ROWID || Date.now()),
          msgSvrId: obj.msgSvrId ? String(obj.msgSvrId) : undefined,
          talkerId: String(obj.talker || obj.TalkerName || 'unknown'),
          senderId: String(obj.sender || obj.talker || 'unknown'),
          type: Number(obj.type || obj.Type || 1),
          subType: obj.subType ? Number(obj.subType) : undefined,
          content: String(obj.content || obj.Content || ''),
          createTime: Number(obj.createTime || obj.CreateTime || 0),
          sequence: obj.sequence ? Number(obj.sequence) : undefined,
          isSend: Boolean(obj.isSend || obj.IsSender || false),
          status: obj.status ? Number(obj.status) : undefined,
          mediaPath: obj.mediaPath || obj.MediaPath || undefined,
          extra: obj.extra || {},
        });
      } catch {
        // 跳过解析失败的行
      }
    }

    return messages;
  }
}
