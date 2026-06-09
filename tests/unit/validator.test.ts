/**
 * 客户识别校验器单元测试
 */

import { validateClassification, validateCustomerInfo } from '../../src/analyzer/validator';
import { ContactClassification } from '../../src/types';

describe('validateClassification', () => {
  it('应通过有效的客户分类', () => {
    const valid: Partial<ContactClassification> = {
      isCustomer: true,
      customerType: 'b2b',
      subType: '公司法人',
      confidence: 0.95,
      reasoning: '客户询问建筑资质申报',
    };

    expect(() => validateClassification(valid)).not.toThrow();
  });

  it('应通过有效的非客户分类', () => {
    const valid: Partial<ContactClassification> = {
      isCustomer: false,
      confidence: 0.9,
      reasoning: '日常闲聊',
    };

    expect(() => validateClassification(valid)).not.toThrow();
  });

  it('应标记超出范围的置信度', () => {
    const invalid: Partial<ContactClassification> = {
      isCustomer: true,
      confidence: 1.5,
    };

    expect(() => validateClassification(invalid)).not.toThrow();
  });

  it('应检测到客户类型不一致', () => {
    const inconsistent: Partial<ContactClassification> = {
      isCustomer: true,
      customerType: undefined,
      confidence: 0.8,
    };

    expect(() => validateClassification(inconsistent)).not.toThrow();
  });
});

describe('validateCustomerInfo', () => {
  it('应通过有效的B端客户信息', () => {
    const info = {
      companyName: 'XX建筑公司',
      demandType: '建筑资质申报',
      urgency: 'high',
      followUpStatus: 'quoted',
      projectTypes: ['建筑资质', '安许'],
    };

    expect(() => validateCustomerInfo(info, 'b2b')).not.toThrow();
  });

  it('应通过有效的C端客户信息', () => {
    const info = {
      name: '张三',
      examType: '二级建造师',
      demandType: '题库',
      followUpStatus: 'interested',
      purchaseHistory: ['2025年二建题库'],
    };

    expect(() => validateCustomerInfo(info, 'b2c')).not.toThrow();
  });

  it('应标记无效的B端跟进状态', () => {
    const info = {
      followUpStatus: 'invalid_status',
    };

    expect(() => validateCustomerInfo(info, 'b2b')).not.toThrow();
  });

  it('应标记无效的C端跟进状态', () => {
    const info = {
      followUpStatus: 'closed',
    };

    expect(() => validateCustomerInfo(info, 'b2c')).not.toThrow();
  });
});
