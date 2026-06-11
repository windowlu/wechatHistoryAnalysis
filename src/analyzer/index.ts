/**
 * 分析层 (Analyzer)
 * 客户识别与分类系统
 * 两阶段分析流程：
 *   阶段1: 客户识别分类（全部会话）
 *   阶段2: 关键信息提取（仅客户会话）
 */

import axios, { AxiosError } from 'axios';
import {
  NormalizedSession,
  SessionAnalysis,
  AnalyzerConfig,
  AnalysisResult,
  LLMConfig,
  ContactClassification,
  B2BCustomerInfo,
  B2CCustomerInfo,
} from '../types';
import { logger } from '../utils/logger';
import { chunkArray } from '../utils/stream-helper';
import {
  CLASSIFICATION_PROMPT,
  B2B_EXTRACTION_PROMPT,
  B2C_EXTRACTION_PROMPT,
  FALLBACK_CLASSIFICATION_PROMPT,
} from './prompts';
import { validateClassification, validateCustomerInfo } from './validator';

/**
 * 按最近 N 天有聊天过滤会话
 * @param sessions 会话列表
 * @param lookbackDays 最近 N 天；<= 0 表示不过滤
 * @param now 基准时间（用于测试注入）
 * @returns 过滤后的会话列表
 */
export function filterSessionsByRecentActivity(
  sessions: NormalizedSession[],
  lookbackDays: number,
  now: number = Date.now(),
): NormalizedSession[] {
  if (lookbackDays <= 0) {
    logger.info('lookbackDays 为 0，分析全部会话');
    return sessions;
  }

  const cutoffMs = now - lookbackDays * 24 * 60 * 60 * 1000;
  const filtered = sessions.filter((session) => {
    const lastMessageMs = new Date(session.timeRange.end).getTime();
    return lastMessageMs >= cutoffMs;
  });

  logger.info(`按最近 ${lookbackDays} 天过滤会话: ${sessions.length} -> ${filtered.length}`);
  return filtered;
}

// 动态导入p-limit以避免ESM/CJS兼容问题
let pLimit: (concurrency: number) => <T>(fn: () => Promise<T>) => Promise<T>;
try {
  const pl = require('p-limit');
  pLimit = pl.default || pl;
} catch {
  pLimit = (n: number) => async <T>(fn: () => Promise<T>) => fn();
}

export class Analyzer {
  private config: AnalyzerConfig;

  constructor(config: AnalyzerConfig) {
    this.config = config;
  }

  /**
   * 执行两阶段全部分析
   * 阶段1: 对所有会话进行客户识别分类
   * 阶段2: 对识别为客户的会话提取关键信息
   */
  async analyze(sessions: NormalizedSession[]): Promise<AnalysisResult> {
    logger.info(`分析层: 开始分析 ${sessions.length} 个会话`);
    const startTime = Date.now();

    // 按最近 N 天过滤会话
    const filteredSessions = this.filterSessionsByLookbackDays(sessions);

    // ═══════════════════════════════════════════════════════
    // 阶段1: 客户识别分类
    // ═══════════════════════════════════════════════════════
    logger.info('阶段1: 客户识别分类');
    const classificationResult = await this.classifySessions(filteredSessions);

    const customerClassifications = classificationResult.results;
    const classifyFailed = classificationResult.failed;

    // 统计分类结果
    const customerCount = customerClassifications.filter((c) => c.isCustomer).length;
    const b2bCount = customerClassifications.filter((c) => c.customerType === 'b2b').length;
    const b2cCount = customerClassifications.filter((c) => c.customerType === 'b2c').length;
    const nonCustomerCount = filteredSessions.length - customerCount;

    logger.info(
      `分类完成: 客户 ${customerCount} (B端 ${b2bCount}, C端 ${b2cCount}), 非客户 ${nonCustomerCount}, 失败 ${classifyFailed.length}`,
    );

    // ═══════════════════════════════════════════════════════
    // 阶段2: 关键信息提取（仅对客户）
    // ═══════════════════════════════════════════════════════
    // 筛选需要提取信息的客户会话
    const customerSessions: NormalizedSession[] = [];
    const customerClassificationsList: ContactClassification[] = [];

    for (let i = 0; i < filteredSessions.length; i++) {
      const cls = customerClassifications[i];
      if (cls.isCustomer) {
        // 如果设置了目标客户类型过滤
        const targetType = this.config.classification.targetCustomerType;
        if (targetType && cls.customerType !== targetType) {
          continue;
        }
        customerSessions.push(filteredSessions[i]);
        customerClassificationsList.push(cls);
      }
    }

    logger.info(`阶段2: 关键信息提取 (${customerSessions.length} 个客户会话)`);
    const extractionResult = await this.extractCustomerInfo(customerSessions, customerClassificationsList);

    // ═══════════════════════════════════════════════════════
    // 组装最终结果
    // ═══════════════════════════════════════════════════════
    const success: SessionAnalysis[] = extractionResult.results;
    const extractFailed = extractionResult.failed;

    // 如果不过滤非客户，将非客户也加入结果（仅含分类信息）
    if (!this.config.classification.filterNonCustomers) {
      for (let i = 0; i < filteredSessions.length; i++) {
        const cls = customerClassifications[i];
        if (!cls.isCustomer) {
          success.push({
            talkerId: filteredSessions[i].talkerId,
            talkerName: filteredSessions[i].name,
            classification: cls,
            keyInsights: [],
            lastActiveAt: filteredSessions[i].timeRange.end,
            messageCount: filteredSessions[i].messages.length,
            analyzedAt: new Date().toISOString(),
            model: 'classification-only',
          });
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const avgDurationMs = success.length > 0 ? Math.round(totalDurationMs / success.length) : 0;

    logger.info(
      `分析层完成: 成功 ${success.length}/${filteredSessions.length}, 分类失败 ${classifyFailed.length}, 提取失败 ${extractFailed.length}, 耗时 ${totalDurationMs}ms`,
    );

    return {
      success,
      failed: [...classifyFailed, ...extractFailed],
      stats: {
        totalSessions: filteredSessions.length,
        successCount: success.length,
        failCount: classifyFailed.length + extractFailed.length,
        customerCount,
        b2bCount,
        b2cCount,
        nonCustomerCount,
        totalDurationMs,
        avgDurationMs,
      },
    };
  }

  /**
   * 按最近 N 天过滤会话
   * 只保留最后一条消息时间在 N 天内的会话
   */
  private filterSessionsByLookbackDays(sessions: NormalizedSession[]): NormalizedSession[] {
    const lookbackDays = this.config.classification.lookbackDays ?? 7;
    return filterSessionsByRecentActivity(sessions, lookbackDays);
  }

  /**
   * 阶段1: 批量客户识别分类
   */
  private async classifySessions(sessions: NormalizedSession[]): Promise<{
    results: ContactClassification[];
    failed: Array<{ talkerId: string; reason: string; retryable: boolean }>;
  }> {
    const results: ContactClassification[] = new Array(sessions.length);
    const failed: Array<{ talkerId: string; reason: string; retryable: boolean }> = [];

    const batches = chunkArray(sessions, this.config.batchSize);

    for (let i = 0; i < batches.length; i++) {
      logger.info(`分类批次 ${i + 1}/${batches.length} (${batches[i].length} 个会话)`);

      const limit = pLimit(this.config.concurrencyLimit);
      const batchResults = await Promise.all(
        batches[i].map((session, idx) =>
          limit(async () => {
            try {
              const result = await this.classifySingleSession(session);
              return { type: 'success' as const, index: i * this.config.batchSize + idx, result };
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              const retryable = this.isRetryableError(err);
              return { type: 'failed' as const, index: i * this.config.batchSize + idx, talkerId: session.talkerId, reason, retryable };
            }
          }),
        ),
      );

      for (const r of batchResults) {
        if (r.type === 'success') {
          results[r.index] = r.result;
        } else {
          failed.push({ talkerId: r.talkerId, reason: r.reason, retryable: r.retryable });
          // 失败时填充默认值
          results[r.index] = {
            isCustomer: false,
            confidence: 0,
            reasoning: `分类失败: ${r.reason}`,
          };
        }
      }
    }

    return { results, failed };
  }

  /**
   * 对单个会话进行分类
   */
  private async classifySingleSession(session: NormalizedSession): Promise<ContactClassification> {
    const context = this.buildSessionContext(session);
    const compressedContext = this.compressContextIfNeeded(context, session);

    const rawOutput = await this.callLLMRaw(compressedContext, CLASSIFICATION_PROMPT, false);

    let parsed: Partial<ContactClassification>;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('分类输出不是有效的JSON');
      }
    }

    // 校验
    if (this.config.validation.enableRangeCheck) {
      validateClassification(parsed);
    }

    return {
      isCustomer: parsed.isCustomer ?? false,
      customerType: parsed.customerType,
      subType: parsed.subType,
      confidence: parsed.confidence ?? 0.5,
      reasoning: parsed.reasoning ?? '',
    };
  }

  /**
   * 阶段2: 批量关键信息提取
   */
  private async extractCustomerInfo(
    sessions: NormalizedSession[],
    classifications: ContactClassification[],
  ): Promise<{
    results: SessionAnalysis[];
    failed: Array<{ talkerId: string; reason: string; retryable: boolean }>;
  }> {
    const results: SessionAnalysis[] = [];
    const failed: Array<{ talkerId: string; reason: string; retryable: boolean }> = [];

    const batches = chunkArray(sessions, this.config.batchSize);

    for (let i = 0; i < batches.length; i++) {
      logger.info(`提取批次 ${i + 1}/${batches.length} (${batches[i].length} 个会话)`);

      const limit = pLimit(this.config.concurrencyLimit);
      const batchResults = await Promise.all(
        batches[i].map((session, idx) =>
          limit(async () => {
            const globalIdx = i * this.config.batchSize + idx;
            const classification = classifications[globalIdx];
            try {
              const result = await this.extractSingleSession(session, classification);
              return { type: 'success' as const, result };
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              const retryable = this.isRetryableError(err);
              return { type: 'failed' as const, talkerId: session.talkerId, reason, retryable };
            }
          }),
        ),
      );

      for (const r of batchResults) {
        if (r.type === 'success') {
          results.push(r.result);
        } else {
          failed.push({ talkerId: r.talkerId, reason: r.reason, retryable: r.retryable });
        }
      }
    }

    return { results, failed };
  }

  /**
   * 对单个客户会话提取关键信息
   */
  private async extractSingleSession(
    session: NormalizedSession,
    classification: ContactClassification,
  ): Promise<SessionAnalysis> {
    const context = this.buildSessionContext(session);
    const compressedContext = this.compressContextIfNeeded(context, session);

    const prompt =
      classification.customerType === 'b2b' ? B2B_EXTRACTION_PROMPT : B2C_EXTRACTION_PROMPT;

    const rawOutput = await this.callLLMRaw(compressedContext, prompt, false);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = {};
      }
    }

    // 校验
    if (
      this.config.validation.enableRangeCheck &&
      classification.customerType
    ) {
      validateCustomerInfo(parsed, classification.customerType);
    }

    const customerInfo =
      classification.customerType === 'b2b'
        ? (parsed as B2BCustomerInfo)
        : (parsed as B2CCustomerInfo);

    return {
      talkerId: session.talkerId,
      talkerName: session.name,
      classification,
      customerInfo,
      keyInsights: this.generateKeyInsights(classification, customerInfo),
      lastActiveAt: session.timeRange.end,
      messageCount: session.messages.length,
      analyzedAt: new Date().toISOString(),
      model: this.config.llm.primaryModel,
    };
  }

  /**
   * 生成关键洞察摘要
   */
  private generateKeyInsights(
    classification: ContactClassification,
    customerInfo: B2BCustomerInfo | B2CCustomerInfo,
  ): string[] {
    const insights: string[] = [];

    if (classification.customerType === 'b2b') {
      const info = customerInfo as B2BCustomerInfo;
      if (info.companyName) insights.push(`公司: ${info.companyName}`);
      if (info.contactRole) insights.push(`角色: ${info.contactRole}`);
      if (info.demandType) insights.push(`需求: ${info.demandType}`);
      if (info.urgency) insights.push(`紧急度: ${info.urgency}`);
      if (info.followUpStatus) insights.push(`跟进: ${info.followUpStatus}`);
    } else {
      const info = customerInfo as B2CCustomerInfo;
      if (info.examType) insights.push(`考试: ${info.examType}`);
      if (info.demandType) insights.push(`需求: ${info.demandType}`);
      if (info.major) insights.push(`专业: ${info.major}`);
      if (info.region) insights.push(`地区: ${info.region}`);
      if (info.followUpStatus) insights.push(`跟进: ${info.followUpStatus}`);
    }

    return insights;
  }

  /**
   * 构建会话分析上下文
   */
  private buildSessionContext(session: NormalizedSession): string {
    const lines: string[] = [];
    lines.push(`会话: ${session.name}`);
    lines.push(`类型: ${session.type === 'single' ? '单聊' : '群聊'}`);
    lines.push(`消息数: ${session.messages.length}`);
    lines.push(`时间范围: ${session.timeRange.start} ~ ${session.timeRange.end}`);
    lines.push('---');

    for (const msg of session.messages) {
      const sender = msg.senderInfo?.nickname || msg.senderInfo?.remark || msg.senderId;
      const direction = msg.isSelf ? '[我方]' : '[对方]';
      const time = new Date(msg.timestampMs).toLocaleString('zh-CN');
      lines.push(`${time} ${direction} ${sender}: ${msg.content}`);
    }

    return lines.join('\n');
  }

  /**
   * 如果上下文超过阈值，执行压缩
   */
  private compressContextIfNeeded(context: string, session: NormalizedSession): string {
    const estimatedTokens = context.length * 1.5;

    if (estimatedTokens <= this.config.compressionThreshold) {
      return context;
    }

    logger.debug(`会话 ${session.talkerId} 需要上下文压缩`);

    const msgs = session.messages;
    const keepCount = Math.floor(msgs.length * 0.15);

    const head = msgs.slice(0, keepCount);
    const tail = msgs.slice(-keepCount);

    const lines: string[] = [];
    lines.push(`会话: ${session.name} (已压缩，显示 ${keepCount * 2}/${msgs.length} 条关键消息)`);
    lines.push('---');

    for (const msg of head) {
      const sender = msg.senderInfo?.nickname || msg.senderId;
      const direction = msg.isSelf ? '[我方]' : '[对方]';
      lines.push(`${direction} ${sender}: ${msg.content}`);
    }

    lines.push('[... 中间消息已压缩 ...]');

    for (const msg of tail) {
      const sender = msg.senderInfo?.nickname || msg.senderId;
      const direction = msg.isSelf ? '[我方]' : '[对方]';
      lines.push(`${direction} ${sender}: ${msg.content}`);
    }

    return lines.join('\n');
  }

  /**
   * 调用LLM，返回原始文本输出
   */
  private async callLLMRaw(
    context: string,
    prompt: string,
    isFallback: boolean,
  ): Promise<string> {
    const llm = this.config.llm;
    const model = isFallback ? llm.fallbackModel! : llm.primaryModel;

    const response = await axios.post(
      llm.apiEndpoint,
      {
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: context },
        ],
        temperature: llm.temperature,
        ...(this.config.enforceJsonMode && !isFallback ? { response_format: { type: 'json_object' } } : {}),
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        timeout: llm.timeoutMs,
      },
    );

    return response.data.choices?.[0]?.message?.content || '';
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    }
    return false;
  }
}
