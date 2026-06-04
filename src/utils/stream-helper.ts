/**
 * 流式处理工具
 * 提供大文件逐行读取、分片处理、内存控制等功能
 */

import * as fs from 'fs';
import * as readline from 'readline';

/**
 * 逐行读取JSONL文件
 * @param filePath JSONL文件路径
 * @param batchSize 每批处理行数
 * @param processor 批处理器
 */
export async function processJsonlInBatches<T>(
  filePath: string,
  batchSize: number,
  processor: (batch: T[]) => Promise<void>,
): Promise<{ totalLines: number; processedLines: number }> {
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let batch: T[] = [];
  let totalLines = 0;
  let processedLines = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as T;
      batch.push(obj);
      totalLines++;

      if (batch.length >= batchSize) {
        await processor(batch);
        processedLines += batch.length;
        batch = [];
      }
    } catch {
      // 跳过解析失败的行
    }
  }

  // 处理剩余批次
  if (batch.length > 0) {
    await processor(batch);
    processedLines += batch.length;
  }

  fileStream.close();
  return { totalLines, processedLines };
}

/**
 * 将对象流写入JSONL文件
 * @param filePath 输出路径
 * @param records 记录迭代器
 */
export async function writeJsonlStream<T>(
  filePath: string,
  records: AsyncIterable<T> | Iterable<T>,
): Promise<number> {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
  let count = 0;

  for await (const record of records) {
    stream.write(JSON.stringify(record) + '\n');
    count++;
  }

  return new Promise((resolve, reject) => {
    stream.end(() => resolve(count));
    stream.on('error', reject);
  });
}

/**
 * 分片数组
 * @param array 原始数组
 * @param size 每片大小
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * 带内存上限的Map
 * 当键数量超过上限时，按LRU策略淘汰
 */
export class LruMap<K, V> extends Map<K, V> {
  private maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  set(key: K, value: V): this {
    // 如果键已存在，先删除再重新添加，确保移到最近使用位置
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxSize) {
      // 容量已满，淘汰最久未使用项
      const firstKey = this.keys().next().value;
      if (firstKey !== undefined) {
        this.delete(firstKey);
      }
    }
    return super.set(key, value);
  }
}
