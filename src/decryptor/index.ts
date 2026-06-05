/**
 * 解密层 (Decryptor)
 * 支持多种解密工具：generic 外部工具 / PyWxDump
 * 以独立子进程方式运行，与主进程隔离
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn, SpawnOptions } from 'child_process';
import { DecryptorConfig, DecryptionResult, RawMessage } from '../types';
import { logger } from '../utils/logger';
import { writeJsonlStream } from '../utils/stream-helper';

// 懒加载 better-sqlite3，避免未安装时报错影响其他层
let BetterSQLite3: any;
function getSQLite(): any {
  if (!BetterSQLite3) {
    try {
      BetterSQLite3 = require('better-sqlite3');
    } catch (err) {
      throw new Error(
        '读取 PyWxDump 解密后的 SQLite 数据库需要 better-sqlite3。\n' +
          '请安装: npm install better-sqlite3\n' +
          'Windows 用户可能需要先安装 Python 和 Visual Studio Build Tools。\n' +
          '或者使用 toolType="generic" 配合其他解密工具。'
      );
    }
  }
  return BetterSQLite3;
}

/**
 * 安全获取行数据，支持多个候选列名（大小写不敏感）
 */
function getRowValue(row: Record<string, unknown>, ...candidates: string[]): unknown {
  for (const name of candidates) {
    if (name in row) return row[name];
  }
  return undefined;
}

export class Decryptor {
  private config: DecryptorConfig;

  constructor(config: DecryptorConfig) {
    this.config = config;
  }

  /**
   * 执行批量解密
   * @param dbPaths 待解密的数据库文件路径列表
   * @param _microMsgDbPath 联系人数据库路径（generic 工具可选使用）
   */
  async decrypt(dbPaths: string[], _microMsgDbPath?: string): Promise<DecryptionResult> {
    logger.info(`解密层: 开始批量解密 [工具=${this.config.toolType}]`);
    const startTime = Date.now();

    await fs.ensureDir(this.config.outputDir);

    // 1. 获取解密密钥
    const key = await this.resolveKey();
    if (!key && this.config.toolType === 'generic') {
      throw new Error('无法获取数据库解密密钥，请确保微信已登录或提供手动密钥');
    }
    if (this.config.toolType === 'pywxdump') {
      // PyWxDump 的 decrypt 可能自动复用 bias 结果，key 不一定需要显式传入
      logger.info('PyWxDump 模式: 密钥将通过 bias 自动获取');
    } else {
      logger.info('密钥获取成功');
    }

    // 2. 逐库解密
    const outputPath = path.join(this.config.outputDir, 'raw_messages.jsonl');
    const allMessages: RawMessage[] = [];
    const shardStats: Array<{ dbPath: string; messageCount: number }> = [];
    const failedShards: string[] = [];

    for (const dbPath of dbPaths) {
      try {
        logger.debug(`解密数据库: ${path.basename(dbPath)}`);
        const messages = await this.decryptSingleDb(dbPath, key || '');
        allMessages.push(...messages);
        shardStats.push({ dbPath, messageCount: messages.length });
        logger.info(`${path.basename(dbPath)}: ${messages.length} 条消息`);
      } catch (err) {
        logger.error(`解密失败: ${dbPath}`, { error: String(err) });
        failedShards.push(dbPath);
      }
    }

    // 3. 按时间排序并写入 JSONL
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

  // ═════════════════════════════════════════════════════════════════════════════
  // 密钥解析
  // ═════════════════════════════════════════════════════════════════════════════

  private async resolveKey(): Promise<string | null> {
    if (this.config.manualKey) {
      logger.debug('使用手动提供的密钥');
      return this.config.manualKey;
    }

    switch (this.config.toolType) {
      case 'pywxdump':
        return this.resolveKeyPyWxDump();
      case 'generic':
      default:
        return this.resolveKeyGeneric();
    }
  }

  private async resolveKeyGeneric(): Promise<string | null> {
    switch (this.config.strategy) {
      case 'memory':
        return this.extractKeyFromMemoryGeneric();
      case 'cache':
        return this.extractKeyFromCacheGeneric();
      default:
        // 自动策略：依次尝试 memory → cache
        let key = await this.extractKeyFromMemoryGeneric();
        if (key) return key;
        key = await this.extractKeyFromCacheGeneric();
        return key || this.config.manualKey || null;
    }
  }

  private async resolveKeyPyWxDump(): Promise<string | null> {
    logger.debug('使用 PyWxDump 获取密钥 (bias --auto)');
    try {
      const { stdout } = await this.runPyWxDump(
        ['bias', '--auto', ...(this.config.pywxdumpBiasArgs || [])],
        60000
      );
      const key = this.parseKeyFromPyWxDumpOutput(stdout);
      if (key) {
        logger.debug(`PyWxDump 解析到密钥: ${key.substring(0, 8)}...`);
      }
      return key;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`PyWxDump 获取密钥失败: ${msg}`);
      // bias 失败不阻断，PyWxDump decrypt 可能自动处理
      return null;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // 单库解密
  // ═════════════════════════════════════════════════════════════════════════════

  private async decryptSingleDb(dbPath: string, key: string): Promise<RawMessage[]> {
    switch (this.config.toolType) {
      case 'pywxdump':
        return this.decryptSingleDbPyWxDump(dbPath, key);
      case 'generic':
      default:
        return this.decryptSingleDbGeneric(dbPath, key);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // Generic 外部工具方法
  // ═════════════════════════════════════════════════════════════════════════════

  private async extractKeyFromMemoryGeneric(): Promise<string | null> {
    logger.debug('尝试从内存中提取密钥 (generic)');
    const toolPath = this.config.decryptToolPath;
    if (!toolPath || !(await fs.pathExists(toolPath))) {
      logger.warn(`密钥提取工具不存在: ${toolPath}`);
      return null;
    }
    try {
      return await this.runKeyExtractor(toolPath, 'memory');
    } catch (err) {
      logger.warn('内存提取密钥失败', { error: String(err) });
      return null;
    }
  }

  private async extractKeyFromCacheGeneric(): Promise<string | null> {
    logger.debug('尝试从本地缓存中提取密钥 (generic)');
    const toolPath = this.config.decryptToolPath;
    if (!toolPath || !(await fs.pathExists(toolPath))) {
      return null;
    }
    try {
      return await this.runKeyExtractor(toolPath, 'cache');
    } catch (err) {
      logger.warn('缓存提取密钥失败', { error: String(err) });
      return null;
    }
  }

  private runKeyExtractor(toolPath: string, mode: 'memory' | 'cache'): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const proc = spawn(toolPath, ['--mode', mode, '--key-only'], {
        timeout: 30000,
        windowsHide: true,
      } as SpawnOptions);

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(stderr || `进程退出码 ${code}`));
          return;
        }
        resolve(stdout.trim() || null);
      });

      proc.on('error', reject);
    });
  }

  private async decryptSingleDbGeneric(dbPath: string, key: string): Promise<RawMessage[]> {
    const toolPath = this.config.decryptToolPath;
    if (!toolPath) {
      throw new Error('未配置 generic 解密工具路径 (decryptToolPath)');
    }

    return new Promise((resolve, reject) => {
      const args = ['--mode', 'decrypt', '--db', dbPath, '--key', key, '--format', 'json'];
      const proc = spawn(toolPath, args, {
        timeout: 120000,
        windowsHide: true,
      } as SpawnOptions);

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new Error(stderr || `解密进程退出码 ${code}`));
          return;
        }
        try {
          resolve(this.parseDecryptOutput(stdout));
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', reject);
    });
  }

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

  // ═════════════════════════════════════════════════════════════════════════════
  // PyWxDump 专用方法
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * 运行 PyWxDump 子进程
   */
  private async runPyWxDump(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string }> {
    const pythonPath = this.config.pythonPath || 'python';
    const pywxdumpModule = this.config.pywxdumpModule || 'pywxdump';

    return new Promise((resolve, reject) => {
      const proc = spawn(pythonPath, ['-m', pywxdumpModule, ...args], {
        timeout: timeoutMs,
        windowsHide: true,
        cwd: process.cwd(),
      } as SpawnOptions);

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        // PyWxDump 有时会在 stderr 输出日志但返回 0
        if (code !== 0 && code !== null) {
          reject(
            new Error(`PyWxDump 退出码 ${code}${stderr ? ': ' + stderr : stdout ? ': ' + stdout : ''}`)
          );
          return;
        }
        resolve({ stdout, stderr });
      });

      proc.on('error', (err: Error) => {
        reject(
          new Error(
            `无法启动 PyWxDump: ${err.message}。` +
              `请确保已安装: ${pythonPath} -m pip install pywxdump`
          )
        );
      });
    });
  }

  /**
   * 从 PyWxDump bias 输出中解析密钥
   */
  private parseKeyFromPyWxDumpOutput(output: string): string | null {
    // 策略1: 尝试从 JSON 行解析
    const lines = output.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.key && typeof obj.key === 'string') {
          return obj.key.trim();
        }
      } catch {
        // 不是 JSON，继续
      }
    }

    // 策略2: 正则匹配 32/64 位十六进制 key
    const hexKeyMatch = output.match(/\b([0-9a-fA-F]{32}|[0-9a-fA-F]{64})\b/);
    if (hexKeyMatch) {
      return hexKeyMatch[1];
    }

    // 策略3: 查找 "key" / "密钥" / "KEY" 后的值
    const keyLineMatch = output.match(/(?:key|密钥|KEY)[=:\s]+([0-9a-fA-F]{32,64})/i);
    if (keyLineMatch) {
      return keyLineMatch[1].trim();
    }

    return null;
  }

  /**
   * 使用 PyWxDump 解密单个数据库，并用 better-sqlite3 读取消息
   */
  private async decryptSingleDbPyWxDump(dbPath: string, _key: string): Promise<RawMessage[]> {
    const tempDir = path.join(this.config.outputDir, '_pywxdump_temp');
    await fs.ensureDir(tempDir);

    const baseName = path.basename(dbPath);
    const decryptedPath = path.join(tempDir, `${baseName}.decrypted`);

    try {
      // 1. 调用 PyWxDump 解密
      logger.debug(`PyWxDump 解密: ${baseName} → ${decryptedPath}`);
      await this.runPyWxDump(
        ['decrypt', '--input', dbPath, '--output', decryptedPath],
        120000
      );

      // 2. 验证解密文件
      if (!(await fs.pathExists(decryptedPath))) {
        throw new Error('PyWxDump 解密后未生成目标文件，可能密钥不匹配或命令参数有误');
      }
      const stats = await fs.stat(decryptedPath);
      if (stats.size === 0) {
        throw new Error('PyWxDump 解密后的文件为空');
      }

      // 3. 用 better-sqlite3 读取消息
      return this.readMessagesFromSQLite(decryptedPath);
    } finally {
      // 4. 清理临时文件
      try {
        await fs.remove(decryptedPath);
      } catch {
        // 忽略清理错误
      }
    }
  }

  /**
   * 从 SQLite 数据库中读取微信消息
   */
  private readMessagesFromSQLite(dbPath: string): RawMessage[] {
    const Database = getSQLite();
    const db = new Database(dbPath, { readonly: true });

    try {
      // 检测 MSG 表（微信消息主表）
      const tableInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND UPPER(name)='MSG'")
        .get() as { name: string } | undefined;

      if (!tableInfo) {
        db.close();
        throw new Error('数据库中未找到 MSG 消息表');
      }

      const tableName = tableInfo.name; // 保留原始大小写

      // 获取列名，用于后续动态映射
      const columns = db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));

      // 构建查询：优先使用已知的标准列名
      const selectCols: string[] = [];
      const colMap: Record<string, string[]> = {
        msgId: ['msgId', 'MsgId', 'MSGId', 'localId'],
        msgSvrId: ['msgSvrId', 'MsgSvrID', 'MsgSrvId'],
        type: ['type', 'Type', 'msgType', 'MsgType'],
        subType: ['subType', 'SubType'],
        isSend: ['isSend', 'IsSender', 'IsSend', 'issend'],
        createTime: ['createTime', 'CreateTime'],
        sequence: ['sequence', 'Sequence', 'seq', 'Seq'],
        status: ['status', 'Status', 'statusEx', 'StatusEx'],
        talker: ['strTalker', 'StrTalker', 'talker', 'Talker', 'toUser'],
        content: ['strContent', 'StrContent', 'content', 'Content'],
      };

      for (const [alias, candidates] of Object.entries(colMap)) {
        for (const cand of candidates) {
          if (colNames.has(cand)) {
            selectCols.push(`${cand} AS ${alias}`);
            break;
          }
        }
      }

      // 兜底：如果上述列名都没命中，SELECT *
      const query =
        selectCols.length > 0
          ? `SELECT ${selectCols.join(', ')} FROM ${tableName} ORDER BY createTime ASC, msgId ASC`
          : `SELECT * FROM ${tableName} ORDER BY CreateTime ASC, MsgId ASC`;

      const stmt = db.prepare(query);
      const rows = stmt.all() as Array<Record<string, unknown>>;
      const messages: RawMessage[] = [];

      for (const row of rows) {
        const talkerId = String(getRowValue(row, 'talker', 'strTalker', 'StrTalker') ?? 'unknown');
        const isSend = Boolean(getRowValue(row, 'isSend', 'IsSender', 'IsSend') ?? false);

        messages.push({
          msgId: String(getRowValue(row, 'msgId', 'MsgId', 'localId') ?? `${Date.now()}_${messages.length}`),
          msgSvrId: getRowValue(row, 'msgSvrId', 'MsgSvrID')
            ? String(getRowValue(row, 'msgSvrId', 'MsgSvrID'))
            : undefined,
          talkerId,
          senderId: isSend ? 'self' : talkerId,
          type: Number(getRowValue(row, 'type', 'Type') ?? 1),
          subType: getRowValue(row, 'subType', 'SubType')
            ? Number(getRowValue(row, 'subType', 'SubType'))
            : undefined,
          content: String(getRowValue(row, 'content', 'strContent', 'StrContent') ?? ''),
          createTime: Number(getRowValue(row, 'createTime', 'CreateTime') ?? 0),
          sequence: getRowValue(row, 'sequence', 'Sequence')
            ? Number(getRowValue(row, 'sequence', 'Sequence'))
            : undefined,
          isSend,
          status: getRowValue(row, 'status', 'Status', 'statusEx')
            ? Number(getRowValue(row, 'status', 'Status', 'statusEx'))
            : undefined,
          extra: {
            bytesExtra: getRowValue(row, 'bytesExtra', 'BytesExtra'),
            compressContent: getRowValue(row, 'compressContent', 'CompressContent'),
            displayContent: getRowValue(row, 'displayContent', 'DisplayContent'),
          },
        });
      }

      return messages;
    } finally {
      try {
        db.close();
      } catch {
        // 忽略关闭错误
      }
    }
  }
}
