/**
 * 流水线编排器 (Pipeline)
 * 协调提取层、解密层、标准化层、分析层、持久层的顺序执行
 * 提供错误隔离、局部回滚与执行统计
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import {
  PipelineConfig,
  PipelineResult,
  ExtractionResult,
  DecryptionResult,
  NormalizedSession,
  AnalysisResult,
} from './types';
import { Extractor } from './extractor';
import { Decryptor } from './decryptor';
import { Normalizer } from './normalizer';
import { Analyzer } from './analyzer';
import { Persister } from './persister';
import { logger } from './utils/logger';

export class AnalysisPipeline {
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  /**
   * 执行完整流水线
   */
  async run(): Promise<PipelineResult> {
    const startTime = new Date();
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('微信聊天记录分析流水线 启动');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const result: PipelineResult = {
      success: false,
      stages: {},
      stats: {
        startTime,
        endTime: startTime,
        durationMs: 0,
      },
    };

    let extraction: ExtractionResult | undefined;
    let decryption: DecryptionResult | undefined;
    let sessions: NormalizedSession[] | undefined;
    let analysis: AnalysisResult | undefined;

    try {
      // 初始化日志文件
      await logger.initLogFile(this.config.exporter.outputDir);

      // ═══════════════════════════════════════════════════════
      // 阶段1: 提取层
      // ═══════════════════════════════════════════════════════
      logger.info('[阶段1/5] 提取层: 扫描微信数据目录');
      const extractor = new Extractor(this.config.extractor);
      extraction = await extractor.extract();
      result.stages.extraction = extraction;
      logger.info('提取层完成 ✓');

      // ═══════════════════════════════════════════════════════
      // 阶段2: 解密层
      // ═══════════════════════════════════════════════════════
      logger.info('[阶段2/5] 解密层: 批量解密数据库');
      const msgDbs = extraction.selectedDatabases
        .filter((db) => db.type === 'MSG')
        .map((db) => db.path);
      const microMsgDb = extraction.account.databases.find((db) => db.type === 'MicroMsg')?.path;

      const decryptor = new Decryptor(this.config.decryptor);
      decryption = await decryptor.decrypt(msgDbs, microMsgDb);
      result.stages.decryption = decryption;
      logger.info('解密层完成 ✓');

      // ═══════════════════════════════════════════════════════
      // 阶段3: 标准化层
      // ═══════════════════════════════════════════════════════
      logger.info('[阶段3/5] 标准化层: 清洗与结构化');
      if (microMsgDb) {
        this.config.normalizer.contactDbPath = microMsgDb;
      }
      const normalizer = new Normalizer(this.config.normalizer);
      sessions = await normalizer.normalize(decryption.outputPath);
      result.stages.normalization = {
        sessionCount: sessions.length,
        messageCount: sessions.reduce((sum, s) => sum + s.messages.length, 0),
      };
      logger.info('标准化层完成 ✓');

      // ═══════════════════════════════════════════════════════
      // 阶段4: 分析层
      // ═══════════════════════════════════════════════════════
      logger.info('[阶段4/5] 分析层: LLM智能分析');
      const analyzer = new Analyzer(this.config.analyzer);
      analysis = await analyzer.analyze(sessions);
      result.stages.analysis = analysis;
      logger.info('分析层完成 ✓');

      // ═══════════════════════════════════════════════════════
      // 阶段5: 持久层
      // ═══════════════════════════════════════════════════════
      logger.info('[阶段5/5] 持久层: 导出分析结果');
      const persister = new Persister(this.config.exporter);
      const exportResult = await persister.persist(analysis.success, sessions);
      result.stages.export = exportResult;
      logger.info('持久层完成 ✓');

      // 整体成功
      result.success = true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`流水线执行失败: ${errorMsg}`);
      result.error = errorMsg;

      // 局部回滚：清理临时文件
      await this.cleanup();
    } finally {
      const endTime = new Date();
      result.stats.endTime = endTime;
      result.stats.durationMs = endTime.getTime() - startTime.getTime();

      // 输出汇总
      this.printSummary(result, analysis);
      await logger.close();
    }

    return result;
  }

  /**
   * 针对失败会话的二次分析
   * 无需重新解密全量数据
   */
  async retryFailed(
    failedSessionIds: string[],
    previousResult: PipelineResult,
  ): Promise<PipelineResult> {
    logger.info(`重试分析: ${failedSessionIds.length} 个失败会话`);

    // 读取已有的标准化会话数据
    const rawJsonlPath = path.join(this.config.decryptor.outputDir, 'raw_messages.jsonl');
    const normalizer = new Normalizer(this.config.normalizer);
    const allSessions = await normalizer.normalize(rawJsonlPath);

    // 筛选目标会话
    const targetSessions = allSessions.filter((s) => failedSessionIds.includes(s.talkerId));
    if (targetSessions.length === 0) {
      throw new Error('未找到指定的失败会话');
    }

    // 重新分析
    const analyzer = new Analyzer(this.config.analyzer);
    const analysis = await analyzer.analyze(targetSessions);

    // 导出
    const persister = new Persister(this.config.exporter);
    const exportResult = await persister.persist(analysis.success, targetSessions);

    return {
      success: analysis.failed.length === 0,
      stages: {
        analysis,
        export: exportResult,
      },
      stats: {
        startTime: new Date(),
        endTime: new Date(),
        durationMs: 0,
      },
    };
  }

  /**
   * 清理临时文件
   */
  private async cleanup(): Promise<void> {
    try {
      const tempDir = this.config.tempDir || path.join(process.cwd(), 'temp');
      if (await fs.pathExists(tempDir)) {
        await fs.remove(tempDir);
        logger.debug('临时文件已清理');
      }
    } catch (err) {
      logger.warn('临时文件清理失败', { error: String(err) });
    }
  }

  /**
   * 打印执行汇总
   */
  private printSummary(result: PipelineResult, analysis?: AnalysisResult): void {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('执行汇总');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`总耗时: ${result.stats.durationMs}ms`);
    logger.info(`结果状态: ${result.success ? '成功' : '失败'}`);

    if (result.stages.extraction) {
      logger.info(`账号: ${result.stages.extraction.account.wxid}`);
      logger.info(`数据库分片: ${result.stages.extraction.selectedDatabases.length}`);
    }

    if (result.stages.decryption) {
      logger.info(`解密消息数: ${result.stages.decryption.totalMessages}`);
    }

    if (result.stages.normalization) {
      logger.info(`会话数: ${result.stages.normalization.sessionCount}`);
      logger.info(`消息总数: ${result.stages.normalization.messageCount}`);
    }

    if (analysis) {
      logger.info(`分析成功: ${analysis.stats.successCount}/${analysis.stats.totalSessions}`);
      logger.info(`分析失败: ${analysis.stats.failCount}`);
      if (analysis.failed.length > 0) {
        logger.info('失败会话:');
        for (const f of analysis.failed) {
          logger.info(`  - ${f.talkerId}: ${f.reason} ${f.retryable ? '(可重试)' : ''}`);
        }
      }
    }

    if (result.stages.export) {
      logger.info('输出文件:');
      for (const fp of result.stages.export.filePaths) {
        logger.info(`  - ${fp}`);
      }
    }

    if (result.error) {
      logger.info(`错误: ${result.error}`);
    }

    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}
