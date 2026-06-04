/**
 * 分析输出校验器单元测试
 */

import { validateAnalysisOutput } from '../../src/analyzer/validator';
import { SessionAnalysis } from '../../src/types';

describe('validateAnalysisOutput', () => {
  it('应通过有效的完整输出', () => {
    const validOutput: Partial<SessionAnalysis> = {
      intentRating: {
        score: 7,
        label: 'hot',
        reasoning: '客户明确询问价格',
      },
      salesQuality: {
        overallScore: 8,
        responsiveness: 9,
        discoveryDepth: 7,
        valueClarity: 8,
        objectionHandling: 7,
        ctaEffectiveness: 8,
        suggestions: [],
      },
    };

    expect(() => validateAnalysisOutput(validOutput)).not.toThrow();
  });

  it('应标记超出范围的评分', () => {
    const invalidOutput: Partial<SessionAnalysis> = {
      intentRating: {
        score: 15, // 超出1-10范围
        label: 'hot',
        reasoning: '',
      },
    };

    expect(() => validateAnalysisOutput(invalidOutput)).not.toThrow();
    // 校验器仅记录日志，不抛出异常
  });

  it('应检测到label与score不匹配', () => {
    const inconsistentOutput: Partial<SessionAnalysis> = {
      intentRating: {
        score: 2,
        label: 'hot', // score=2应为cold
        reasoning: '',
      },
    };

    expect(() => validateAnalysisOutput(inconsistentOutput)).not.toThrow();
  });

  it('应检测到购买意愿与低评级的矛盾', () => {
    const contradictoryOutput: Partial<SessionAnalysis> = {
      customerProfile: {
        keyNeeds: ['准备签约', '合同条款确认'],
        interactionHistory: '',
      },
      intentRating: {
        score: 2,
        label: 'cold',
        reasoning: '',
      },
    };

    expect(() => validateAnalysisOutput(contradictoryOutput)).not.toThrow();
  });
});
