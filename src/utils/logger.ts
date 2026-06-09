/**
 * 日志工具
 * 提供统一的日志输出，支持分级与文件持久化
 */

import * as fs from 'fs-extra';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type LogTransport = (
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
) => void;

class Logger {
  private level: LogLevel = 'info';
  private logFile?: string;
  private stream?: fs.WriteStream;
  private transports: LogTransport[] = [];

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  addTransport(transport: LogTransport): void {
    this.transports.push(transport);
  }

  clearTransports(): void {
    this.transports = [];
  }

  async initLogFile(outputDir: string): Promise<void> {
    await fs.ensureDir(outputDir);
    this.logFile = path.join(outputDir, `analysis_${this.formatDate()}.log`);
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private formatDate(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;

    // 控制台输出
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // 文件输出
    if (this.stream) {
      this.stream.write(line);
    }

    // 自定义传输（如 Electron IPC）
    for (const transport of this.transports) {
      try {
        transport(level, message, meta);
      } catch {
        // 忽略 transport 抛出的错误，避免日志系统崩溃
      }
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  async close(): Promise<void> {
    if (this.stream) {
      await new Promise<void>((resolve) => {
        this.stream!.end(() => resolve());
      });
      this.stream = undefined;
    }
  }
}

export const logger = new Logger();
