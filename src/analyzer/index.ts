/**
 * 分析层 (Analyzer)
 * 由AXIOM执行框架驱动，按会话维度进行批量LLM分析
 * 包含会话分片、并发控制、降级策略、输出校验
 */

import axios, { AxiosError } from 'axios';
import { NormalizedSession, SessionAnalysis, AnalyzerConfig, AnalysisResult, LLMConfig } from '../types';
import { logger } from '../utils/logger';
import { chunkArray } from '../utils/stream-helper';
import { ANALYSIS_PROMPT, FALLBACK_PROMPT } from './prompts';
import { validateAnalysisOutput } from './validator';

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
   * 执行全部分析
   */
  async analyze(sessions: NormalizedSession[]): Promise<AnalysisResult> {
    logger.info(`分析层: 开始分析 ${sessions.length} 个会话`);
    const startTime = Date.now();

    const success: SessionAnalysis[] = [];
    const failed: Array<{ talkerId: string; reason: string; retryable: boolean }> = [];

    // 按批次处理
    const batches = chunkArray(sessions, this.config.batchSize);
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (let i = 0; i < batches.length; i++) {
      logger.info(`处理批次 ${i + 1}/${batches.length} (${batches[i].length} 个会话)`);

      const limit = pLimit(this.config.concurrencyLimit);
      const batchResults = await Promise.all(
        batches[i].map((session) =>
          limit(async () => {
            try {
              const result = await this.analyzeSingleSession(session);
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
          success.push(r.result);
          totalPromptTokens += r.result.model.includes('fallback') ? 0 : 1000; // 估算
          totalCompletionTokens += r.result.model.includes('fallback') ? 0 : 500;
        } else {
          failed.push({ talkerId: r.talkerId, reason: r.reason, retryable: r.retryable });
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const avgDurationMs = success.length > 0 ? Math.round(totalDurationMs / success.length) : 0;

    logger.info(
      `分析层完成: 成功 ${success.length}/${sessions.length}, 失败 ${failed.length}, 耗时 ${totalDurationMs}ms`,
    );

    return {
      success,
      failed,
      stats: {
        totalSessions: sessions.length,
        successCount: success.length,
        failCount: failed.length,
        totalDurationMs,
        avgDurationMs,
        tokenUsage: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
        },
      },
    };
  }

  /**
   * 分析单个会话
   */
  private async analyzeSingleSession(session: NormalizedSession): Promise<SessionAnalysis> {
    // 1. 构建分析上下文
    const context = this.buildSessionContext(session);

    // 2. 检查是否需要上下文压缩
    const compressedContext = this.compressContextIfNeeded(context, session);

    // 3. 调用主模型
    try {
      const result = await this.callLLM(compressedContext, session, false);
      return result;
    } catch (err) {
      logger.warn(`主模型分析失败，尝试降级: ${session.talkerId}`);
      // 4. 降级至备用模型
      if (this.config.llm.fallbackModel) {
        try {
          const fallbackResult = await this.callLLM(compressedContext, session, true);
          return fallbackResult;
        } catch (fallbackErr) {
          throw new Error(
            `主模型与备用模型均失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      throw err;
    }
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
      const direction = msg.isSelf ? '[销售]' : '[客户]';
      const time = new Date(msg.timestampMs).toLocaleString('zh-CN');
      lines.push(`${time} ${direction} ${sender}: ${msg.content}`);
    }

    return lines.join('\n');
  }

  /**
   * 如果上下文超过阈值，执行压缩
   */
  private compressContextIfNeeded(context: string, session: NormalizedSession): string {
    // 简单估算token数（中文字符按1.5token计）
    const estimatedTokens = context.length * 1.5;

    if (estimatedTokens <= this.config.compressionThreshold) {
      return context;
    }

    logger.debug(`会话 ${session.talkerId} 需要上下文压缩`);

    const msgs = session.messages;
    const keepCount = Math.floor(msgs.length * 0.15); // 保留首尾各15%

    const head = msgs.slice(0, keepCount);
    const tail = msgs.slice(-keepCount);

    const lines: string[] = [];
    lines.push(`会话: ${session.name} (已压缩，显示 ${keepCount * 2}/${msgs.length} 条关键消息)`);
    lines.push('---');

    // 开头
    for (const msg of head) {
      const sender = msg.senderInfo?.nickname || msg.senderId;
      const direction = msg.isSelf ? '[销售]' : '[客户]';
      lines.push(`${direction} ${sender}: ${msg.content}`);
    }

    lines.push('[... 中间消息已压缩 ...]');

    // 结尾
    for (const msg of tail) {
      const sender = msg.senderInfo?.nickname || msg.senderId;
      const direction = msg.isSelf ? '[销售]' : '[客户]';
      lines.push(`${direction} ${sender}: ${msg.content}`);
    }

    return lines.join('\n');
  }

  /**
   * 调用LLM
   */
  private async callLLM(
    context: string,
    session: NormalizedSession,
    isFallback: boolean,
  ): Promise<SessionAnalysis> {
    const llm = this.config.llm;
    const model = isFallback ? llm.fallbackModel! : llm.primaryModel;
    const prompt = isFallback ? FALLBACK_PROMPT : ANALYSIS_PROMPT;

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

    const rawOutput = response.data.choices?.[0]?.message?.content || '';

    // 解析JSON输出
    let parsed: Partial<SessionAnalysis>;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      // 尝试从文本中提取JSON
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('LLM输出不是有效的JSON');
      }
    }

    // 输出校验
    if (!isFallback && this.config.validation.enableRangeCheck) {
      validateAnalysisOutput(parsed);
    }

    return this.buildSessionAnalysis(parsed, session, model);
  }

  /**
   * 构建完整的SessionAnalysis对象
   */
  private buildSessionAnalysis(
    parsed: Partial<SessionAnalysis>,
    session: NormalizedSession,
    model: string,
  ): SessionAnalysis {
    return {
      talkerId: session.talkerId,
      talkerName: session.name,
      customerProfile: parsed.customerProfile || {
        keyNeeds: [],
        interactionHistory: '',
      },
      intentRating: parsed.intentRating || { score: 5, label: 'warm', reasoning: '' },
      salesQuality: parsed.salesQuality || {
        overallScore: 5,
        responsiveness: 5,
        discoveryDepth: 5,
        valueClarity: 5,
        objectionHandling: 5,
        ctaEffectiveness: 5,
        suggestions: [],
      },
      followUps: parsed.followUps || [],
      sentimentTrends: parsed.sentimentTrends || [],
      riskFlags: parsed.riskFlags || [],
      keyInsights: parsed.keyInsights || [],
      summary: parsed.summary || '',
      analyzedAt: new Date().toISOString(),
      model,
    };
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
