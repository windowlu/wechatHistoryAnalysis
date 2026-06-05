/**
 * 持久层 (Persister)
 * 负责将分析结果写入JSONL、CSV报告
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { createObjectCsvWriter } from 'csv-writer';
import {
  SessionAnalysis,
  NormalizedSession,
  ExportConfig,
} from '../types';
import { logger } from '../utils/logger';
import { writeJsonlStream } from '../utils/stream-helper';

export class Persister {
  private config: ExportConfig;

  constructor(config: ExportConfig) {
    this.config = config;
  }

  /**
   * 执行导出
   */
  async persist(
    analysisResults: SessionAnalysis[],
    sessions: NormalizedSession[],
  ): Promise<{ filePaths: string[] }> {
    logger.info('持久层: 开始导出分析结果');
    const filePaths: string[] = [];

    await fs.ensureDir(this.config.outputDir);

    // 1. 导出JSONL
    if (this.config.exportJsonl) {
      const jsonlPath = path.join(this.config.outputDir, 'analysis_results.jsonl');
      await writeJsonlStream(jsonlPath, analysisResults);
      filePaths.push(jsonlPath);
      logger.info(`JSONL导出完成: ${jsonlPath}`);
    }

    // 2. 导出CSV
    if (this.config.exportCsv) {
      const csvPath = path.join(this.config.outputDir, 'analysis_results.csv');
      await this.exportCsv(csvPath, analysisResults);
      filePaths.push(csvPath);
      logger.info(`CSV导出完成: ${csvPath}`);
    }

    logger.info(`持久层完成: ${filePaths.length} 个文件`);
    return { filePaths };
  }

  /**
   * 导出CSV（扁平化字段）
   */
  private async exportCsv(filePath: string, results: SessionAnalysis[]): Promise<void> {
    const records = results.map((r) => ({
      talkerId: r.talkerId,
      talkerName: r.talkerName,
      summary: r.summary,
      intentScore: r.intentRating.score,
      intentLabel: r.intentRating.label,
      intentReasoning: r.intentRating.reasoning,
      overallScore: r.salesQuality.overallScore,
      responsiveness: r.salesQuality.responsiveness,
      discoveryDepth: r.salesQuality.discoveryDepth,
      valueClarity: r.salesQuality.valueClarity,
      objectionHandling: r.salesQuality.objectionHandling,
      ctaEffectiveness: r.salesQuality.ctaEffectiveness,
      suggestions: r.salesQuality.suggestions.join('; '),
      keyNeeds: r.customerProfile.keyNeeds.join('; '),
      decisionStage: r.customerProfile.decisionStage || '',
      budgetSensitivity: r.customerProfile.budgetSensitivity || '',
      followUps: r.followUps.map((f) => `[${f.priority}]${f.description}`).join('; '),
      riskFlags: r.riskFlags.map((f) => `[${f.severity}]${f.type}:${f.description}`).join('; '),
      keyInsights: r.keyInsights.join('; '),
      analyzedAt: r.analyzedAt,
      model: r.model,
    }));

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: Object.keys(records[0] || {}).map((key) => ({ id: key, title: key })),
    });

    await csvWriter.writeRecords(records);
  }
}
