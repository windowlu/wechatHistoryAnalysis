/**
 * 分析输出校验器
 * 对LLM输出进行数值范围校验与一致性检查
 */

import { SessionAnalysis } from '../types';
import { logger } from '../utils/logger';

/**
 * 校验分析输出
 * 对关键字段进行范围校验与矛盾检测
 */
export function validateAnalysisOutput(output: Partial<SessionAnalysis>): void {
  const issues: string[] = [];

  // 1. 数值范围校验
  if (output.intentRating) {
    const score = output.intentRating.score;
    if (score === undefined || score < 1 || score > 10) {
      issues.push(`意向评分超出范围: ${score}`);
    }
  }

  if (output.salesQuality) {
    const sq = output.salesQuality;
    const scores = [
      sq.overallScore,
      sq.responsiveness,
      sq.discoveryDepth,
      sq.valueClarity,
      sq.objectionHandling,
      sq.ctaEffectiveness,
    ];
    for (const s of scores) {
      if (s === undefined || s < 1 || s > 10) {
        issues.push(`销售质量评分超出范围: ${s}`);
      }
    }
  }

  // 2. 一致性检查
  // 检查：客户表达强烈购买意愿但意向评级为低
  if (output.customerProfile?.keyNeeds?.length && output.intentRating) {
    const keyNeeds = output.customerProfile.keyNeeds.join('');
    const hasStrongIntent =
      /签约|合同|付款|购买|下单|合作|确定|定下来/.test(keyNeeds);
    if (hasStrongIntent && output.intentRating.score <= 3) {
      issues.push('检测到矛盾：客户表达购买意愿但意向评级为cold');
    }
  }

  // 检查：意向评级label与score不匹配
  if (output.intentRating) {
    const { score, label } = output.intentRating;
    const expectedLabel =
      score <= 3 ? 'cold' : score <= 6 ? 'warm' : score <= 9 ? 'hot' : 'closed';
    if (label && label !== expectedLabel) {
      issues.push(`意向评级label不匹配: score=${score}, label=${label}, 期望=${expectedLabel}`);
    }
  }

  // 3. 输出异常但不中断，记录日志
  if (issues.length > 0) {
    logger.warn('LLM输出校验发现问题', { issues });
  }
}
