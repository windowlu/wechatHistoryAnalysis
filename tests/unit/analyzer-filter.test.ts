/**
 * 分析层按最近 N 天过滤会话的单元测试
 */

import { filterSessionsByRecentActivity } from '../../src/analyzer';
import { NormalizedSession } from '../../src/types';

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function makeSession(talkerId: string, lastMessageAt: Date): NormalizedSession {
  return {
    talkerId,
    type: 'single',
    name: talkerId,
    participants: [],
    messages: [],
    timeRange: {
      start: new Date(lastMessageAt.getTime() - 60_000).toISOString(),
      end: lastMessageAt.toISOString(),
    },
    stats: {
      total: 1,
      selfCount: 0,
      otherCount: 1,
      typeDistribution: {} as Record<string, number>,
    },
  };
}

describe('filterSessionsByRecentActivity', () => {
  const now = new Date('2026-06-11T12:00:00Z').getTime();

  it('lookbackDays <= 0 时返回全部会话', () => {
    const sessions = [
      makeSession('old', new Date('2020-01-01T00:00:00Z')),
      makeSession('recent', new Date('2026-06-10T00:00:00Z')),
    ];

    expect(filterSessionsByRecentActivity(sessions, 0, now)).toHaveLength(2);
    expect(filterSessionsByRecentActivity(sessions, -1, now)).toHaveLength(2);
  });

  it('只保留最近 N 天内有消息的会话', () => {
    const sessions = [
      makeSession('5-days-ago', new Date('2026-06-06T10:00:00Z')), // 5 天前
      makeSession('8-days-ago', new Date('2026-06-03T10:00:00Z')), // 8 天前
      makeSession('just-now', new Date('2026-06-11T11:00:00Z')),   // 1 小时前
    ];

    const filtered = filterSessionsByRecentActivity(sessions, 7, now);
    expect(filtered.map((s) => s.talkerId)).toEqual(['5-days-ago', 'just-now']);
  });

  it('空会话列表返回空数组', () => {
    expect(filterSessionsByRecentActivity([], 7, now)).toEqual([]);
  });

  it('边界值：正好在 cutoff 上保留', () => {
    // 7 天前正好 12:00
    const exactlyCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const sessions = [makeSession('boundary', exactlyCutoff)];

    expect(filterSessionsByRecentActivity(sessions, 7, now)).toHaveLength(1);
  });
});
