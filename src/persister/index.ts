/**
 * 持久层 (Persister)
 * 负责将客户识别与分类结果写入JSONL、CSV报告
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
      const jsonlPath = path.join(this.config.outputDir, 'customer_analysis.jsonl');
      await writeJsonlStream(jsonlPath, analysisResults);
      filePaths.push(jsonlPath);
      logger.info(`JSONL导出完成: ${jsonlPath}`);
    }

    // 2. 导出CSV
    if (this.config.exportCsv) {
      const csvPath = path.join(this.config.outputDir, 'customer_list.csv');
      await this.exportCsv(csvPath, analysisResults);
      filePaths.push(csvPath);
      logger.info(`CSV导出完成: ${csvPath}`);
    }

    logger.info(`持久层完成: ${filePaths.length} 个文件`);
    return { filePaths };
  }

  /**
   * 导出CSV（客户列表视图，扁平化字段）
   */
  private async exportCsv(filePath: string, results: SessionAnalysis[]): Promise<void> {
    const records = results.map((r) => {
      const cls = r.classification;
      const isCustomer = cls.isCustomer;

      // 根据客户类型提取信息
      let companyName = '';
      let contactName = '';
      let contactRole = '';
      let demandType = '';
      let demandDetail = '';
      let region = '';
      let urgency = '';
      let budgetRange = '';
      let followUpStatus = '';
      let projectTypes = '';

      let name = '';
      let examType = '';
      let examYear = '';
      let major = '';
      let studyStage = '';
      let purchaseHistory = '';

      if (isCustomer && r.customerInfo) {
        if (cls.customerType === 'b2b') {
          const info = r.customerInfo as Record<string, unknown>;
          companyName = (info.companyName as string) || '';
          contactName = (info.contactName as string) || '';
          contactRole = (info.contactRole as string) || '';
          demandType = (info.demandType as string) || '';
          demandDetail = (info.demandDetail as string) || '';
          region = (info.region as string) || '';
          urgency = (info.urgency as string) || '';
          budgetRange = (info.budgetRange as string) || '';
          followUpStatus = (info.followUpStatus as string) || '';
          projectTypes = Array.isArray(info.projectTypes)
            ? info.projectTypes.join('; ')
            : '';
        } else {
          const info = r.customerInfo as Record<string, unknown>;
          name = (info.name as string) || '';
          examType = (info.examType as string) || '';
          examYear = (info.examYear as string) || '';
          demandType = (info.demandType as string) || '';
          major = (info.major as string) || '';
          region = (info.region as string) || '';
          studyStage = (info.studyStage as string) || '';
          followUpStatus = (info.followUpStatus as string) || '';
          purchaseHistory = Array.isArray(info.purchaseHistory)
            ? info.purchaseHistory.join('; ')
            : '';
        }
      }

      return {
        talkerId: r.talkerId,
        talkerName: r.talkerName,
        isCustomer: isCustomer ? '是' : '否',
        customerType: cls.customerType || '',
        subType: cls.subType || '',
        confidence: cls.confidence,
        reasoning: cls.reasoning,
        // B端字段
        companyName,
        contactName,
        contactRole,
        // C端字段
        name,
        examType,
        examYear,
        major,
        studyStage,
        purchaseHistory,
        // 通用业务字段
        demandType,
        demandDetail,
        region,
        urgency,
        budgetRange,
        followUpStatus,
        projectTypes,
        keyInsights: r.keyInsights.join('; '),
        lastActiveAt: r.lastActiveAt,
        messageCount: r.messageCount,
        analyzedAt: r.analyzedAt,
        model: r.model,
      };
    });

    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: Object.keys(records[0] || {}).map((key) => ({ id: key, title: key })),
    });

    await csvWriter.writeRecords(records);
  }
}
