/**
 * 持久层 (Persister)
 * 负责将分析结果写入JSONL、CSV、HTML报告
 * 可选回写本地PostgreSQL与pgvector向量库
 */

import * as path from 'path';
import * as fs from 'fs-extra';
import { createObjectCsvWriter } from 'csv-writer';
import * as ejs from 'ejs';
import {
  SessionAnalysis,
  NormalizedSession,
  ExportConfig,
  NormalizedMessage,
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

    // 3. 导出HTML报告
    if (this.config.exportHtml) {
      const htmlPath = path.join(this.config.outputDir, 'report.html');
      await this.exportHtml(htmlPath, analysisResults, sessions);
      filePaths.push(htmlPath);
      logger.info(`HTML报告导出完成: ${htmlPath}`);
    }

    // 4. 数据库写入（可选）
    if (this.config.writeToDatabase && this.config.database?.enabled) {
      await this.writeToDatabase(analysisResults, sessions);
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

  /**
   * 导出HTML报告
   */
  private async exportHtml(
    filePath: string,
    results: SessionAnalysis[],
    sessions: NormalizedSession[],
  ): Promise<void> {
    // 统计数据
    const stats = this.computeStats(results);

    // 构建会话详情
    const sessionDetails = results.map((r) => {
      const session = sessions.find((s) => s.talkerId === r.talkerId);
      return { analysis: r, session };
    });

    const templatePath = path.join(__dirname, '../../templates/report.ejs');
    let template: string;

    if (await fs.pathExists(templatePath)) {
      template = await fs.readFile(templatePath, 'utf-8');
    } else {
      // 内联模板兜底
      template = this.getInlineTemplate();
    }

    const html = ejs.render(template, {
      title: this.config.htmlTitle || '微信聊天记录分析报告',
      generatedAt: new Date().toLocaleString('zh-CN'),
      stats,
      sessionDetails,
    });

    await fs.writeFile(filePath, html, 'utf-8');
  }

  /**
   * 计算统计指标
   */
  private computeStats(results: SessionAnalysis[]) {
    const total = results.length;
    if (total === 0) {
      return { total, avgIntentScore: 0, avgSalesQuality: 0, hotCount: 0, riskCount: 0 };
    }

    const totalIntent = results.reduce((sum, r) => sum + r.intentRating.score, 0);
    const totalQuality = results.reduce((sum, r) => sum + r.salesQuality.overallScore, 0);
    const hotCount = results.filter((r) => r.intentRating.label === 'hot' || r.intentRating.label === 'closed').length;
    const riskCount = results.filter((r) => r.riskFlags.some((f) => f.severity === 'critical' || f.severity === 'warning')).length;

    return {
      total,
      avgIntentScore: (totalIntent / total).toFixed(2),
      avgSalesQuality: (totalQuality / total).toFixed(2),
      hotCount,
      riskCount,
    };
  }

  /**
   * 写入数据库（可选）
   */
  private async writeToDatabase(
    results: SessionAnalysis[],
    sessions: NormalizedSession[],
  ): Promise<void> {
    // V1版本：预留数据库写入接口
    // 实际实现需引入pg模块，连接PostgreSQL执行INSERT
    logger.info('数据库写入已启用（预留接口）');
  }

  /**
   * 内联HTML模板
   * 当模板文件不存在时使用
   */
  private getInlineTemplate(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><%= title %></title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  .card { @apply bg-white rounded-lg shadow p-6 mb-4; }
  .badge { @apply inline-block px-2 py-1 text-xs rounded-full font-medium; }
  .badge-hot { @apply bg-red-100 text-red-800; }
  .badge-warm { @apply bg-yellow-100 text-yellow-800; }
  .badge-cold { @apply bg-blue-100 text-blue-800; }
  .badge-closed { @apply bg-green-100 text-green-800; }
  .risk-critical { @apply bg-red-50 border-l-4 border-red-500 p-3; }
  .risk-warning { @apply bg-orange-50 border-l-4 border-orange-500 p-3; }
</style>
</head>
<body class="bg-gray-50 min-h-screen">
<div class="max-w-6xl mx-auto p-6">
  <header class="mb-8">
    <h1 class="text-3xl font-bold text-gray-900"><%= title %></h1>
    <p class="text-gray-500 mt-2">生成时间: <%= generatedAt %></p>
  </header>

  <!-- 统计卡片 -->
  <div class="grid grid-cols-4 gap-4 mb-8">
    <div class="card text-center">
      <div class="text-3xl font-bold text-blue-600"><%= stats.total %></div>
      <div class="text-sm text-gray-600 mt-1">总会话数</div>
    </div>
    <div class="card text-center">
      <div class="text-3xl font-bold text-green-600"><%= stats.avgIntentScore %></div>
      <div class="text-sm text-gray-600 mt-1">平均意向分</div>
    </div>
    <div class="card text-center">
      <div class="text-3xl font-bold text-purple-600"><%= stats.hotCount %></div>
      <div class="text-sm text-gray-600 mt-1">高意向客户</div>
    </div>
    <div class="card text-center">
      <div class="text-3xl font-bold text-red-600"><%= stats.riskCount %></div>
      <div class="text-sm text-gray-600 mt-1">风险会话</div>
    </div>
  </div>

  <!-- 会话列表 -->
  <h2 class="text-xl font-semibold mb-4">会话分析详情</h2>
  <% sessionDetails.forEach(function(detail) { %>
  <div class="card">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h3 class="text-lg font-semibold"><%= detail.analysis.talkerName || detail.analysis.talkerId %></h3>
        <p class="text-sm text-gray-500"><%= detail.analysis.summary %></p>
      </div>
      <span class="badge badge-<%= detail.analysis.intentRating.label %>">
        意向 <%= detail.analysis.intentRating.score %>/10 (<%= detail.analysis.intentRating.label %>)
      </span>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-4">
      <div>
        <h4 class="font-medium text-gray-700 mb-2">销售质量评分</h4>
        <div class="space-y-1 text-sm">
          <div class="flex justify-between"><span>总分</span><span class="font-medium"><%= detail.analysis.salesQuality.overallScore %>/10</span></div>
          <div class="flex justify-between"><span>响应及时性</span><span><%= detail.analysis.salesQuality.responsiveness %>/10</span></div>
          <div class="flex justify-between"><span>需求挖掘</span><span><%= detail.analysis.salesQuality.discoveryDepth %>/10</span></div>
          <div class="flex justify-between"><span>价值传递</span><span><%= detail.analysis.salesQuality.valueClarity %>/10</span></div>
          <div class="flex justify-between"><span>异议处理</span><span><%= detail.analysis.salesQuality.objectionHandling %>/10</span></div>
          <div class="flex justify-between"><span>行动引导</span><span><%= detail.analysis.salesQuality.ctaEffectiveness %>/10</span></div>
        </div>
      </div>
      <div>
        <h4 class="font-medium text-gray-700 mb-2">客户需求</h4>
        <ul class="text-sm space-y-1">
          <% detail.analysis.customerProfile.keyNeeds.forEach(function(need) { %>
          <li class="flex items-start"><span class="text-blue-500 mr-2">•</span><%= need %></li>
          <% }); %>
        </ul>
      </div>
    </div>

    <% if (detail.analysis.followUps.length > 0) { %>
    <div class="mb-4">
      <h4 class="font-medium text-gray-700 mb-2">待跟进事项</h4>
      <div class="space-y-2">
        <% detail.analysis.followUps.forEach(function(item) { %>
        <div class="flex items-center text-sm p-2 bg-gray-50 rounded">
          <span class="badge <%= item.priority === 'high' ? 'bg-red-100 text-red-800' : item.priority === 'medium' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600' %> mr-2"><%= item.priority %></span>
          <span><%= item.description %></span>
        </div>
        <% }); %>
      </div>
    </div>
    <% } %>

    <% if (detail.analysis.riskFlags.length > 0) { %>
    <div>
      <h4 class="font-medium text-gray-700 mb-2">风险标记</h4>
      <div class="space-y-2">
        <% detail.analysis.riskFlags.forEach(function(risk) { %>
        <div class="<%= risk.severity === 'critical' ? 'risk-critical' : 'risk-warning' %> text-sm rounded">
          <strong>[<%= risk.severity %>]</strong> <%= risk.type %>: <%= risk.description %>
        </div>
        <% }); %>
      </div>
    </div>
    <% } %>

    <% if (detail.analysis.keyInsights.length > 0) { %>
    <div class="mt-4 pt-4 border-t">
      <h4 class="font-medium text-gray-700 mb-2">关键洞察</h4>
      <div class="flex flex-wrap gap-2">
        <% detail.analysis.keyInsights.forEach(function(insight) { %>
        <span class="inline-block px-3 py-1 bg-indigo-50 text-indigo-700 text-sm rounded-full"><%= insight %></span>
        <% }); %>
      </div>
    </div>
    <% } %>
  </div>
  <% }); %>
</div>
</body>
</html>`;
  }
}
