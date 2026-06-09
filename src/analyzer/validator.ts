/**
 * 分析输出校验器
 * 对客户识别与分类的LLM输出进行校验
 */

import { ContactClassification } from '../types';
import { logger } from '../utils/logger';

/**
 * 校验分类输出
 */
export function validateClassification(output: Partial<ContactClassification>): void {
  const issues: string[] = [];

  // 1. 必填字段检查
  if (typeof output.isCustomer !== 'boolean') {
    issues.push('isCustomer 必须是布尔值');
  }

  // 2. 置信度范围校验
  if (output.confidence !== undefined) {
    if (output.confidence < 0 || output.confidence > 1) {
      issues.push(`置信度超出范围: ${output.confidence}`);
    }
  }

  // 3. 客户类型一致性检查
  if (output.isCustomer) {
    if (!output.customerType || !['b2b', 'b2c'].includes(output.customerType)) {
      issues.push('已识别为客户但 customerType 无效');
    }
  } else {
    if (output.customerType) {
      issues.push('非客户不应有 customerType');
    }
  }

  if (issues.length > 0) {
    logger.warn('分类输出校验发现问题', { issues });
  }
}

/**
 * 校验客户信息提取输出
 */
export function validateCustomerInfo(output: Record<string, unknown>, type: 'b2b' | 'b2c'): void {
  const issues: string[] = [];

  if (type === 'b2b') {
    // B端字段类型校验
    if (output.urgency && !['high', 'medium', 'low'].includes(output.urgency as string)) {
      issues.push(`B端紧急程度无效: ${output.urgency}`);
    }
    if (output.followUpStatus && !['new', 'contacted', 'quoted', 'negotiating', 'closed'].includes(output.followUpStatus as string)) {
      issues.push(`B端跟进状态无效: ${output.followUpStatus}`);
    }
    if (output.projectTypes && !Array.isArray(output.projectTypes)) {
      issues.push('B端 projectTypes 必须是数组');
    }
  } else {
    // C端字段类型校验
    if (output.followUpStatus && !['new', 'interested', 'purchased', 'inactive'].includes(output.followUpStatus as string)) {
      issues.push(`C端跟进状态无效: ${output.followUpStatus}`);
    }
    if (output.purchaseHistory && !Array.isArray(output.purchaseHistory)) {
      issues.push('C端 purchaseHistory 必须是数组');
    }
  }

  if (issues.length > 0) {
    logger.warn('客户信息提取输出校验发现问题', { issues });
  }
}
