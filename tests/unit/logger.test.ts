/**
 * 日志工具单元测试
 */

import { logger } from '../../src/utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    logger.clearTransports();
    logger.setLevel('info');
  });

  afterEach(() => {
    logger.clearTransports();
  });

  it('应支持添加和调用 transport', () => {
    const transportCalls: Array<{ level: string; message: string }> = [];

    logger.addTransport((level, message) => {
      transportCalls.push({ level, message });
    });

    logger.info('测试消息');

    expect(transportCalls.length).toBe(1);
    expect(transportCalls[0].level).toBe('info');
    expect(transportCalls[0].message).toBe('测试消息');
  });

  it('应支持多个 transport', () => {
    const calls1: string[] = [];
    const calls2: string[] = [];

    logger.addTransport((level, message) => {
      calls1.push(`${level}:${message}`);
    });
    logger.addTransport((level, message) => {
      calls2.push(`${level}:${message}`);
    });

    logger.warn('警告信息');

    expect(calls1).toContain('warn:警告信息');
    expect(calls2).toContain('warn:警告信息');
  });

  it('clearTransports 应清空所有 transport', () => {
    const calls: string[] = [];
    logger.addTransport((level, message) => {
      calls.push(`${level}:${message}`);
    });

    logger.clearTransports();
    logger.info('此消息不应被捕获');

    expect(calls.length).toBe(0);
  });

  it('transport 抛出异常不应影响日志系统', () => {
    logger.addTransport(() => {
      throw new Error('transport 崩溃');
    });

    // 不应抛出异常
    expect(() => logger.info('正常消息')).not.toThrow();
  });

  it('应根据日志级别过滤 transport', () => {
    const calls: string[] = [];
    logger.setLevel('warn');
    logger.addTransport((level, message) => {
      calls.push(`${level}:${message}`);
    });

    logger.debug('debug 消息');
    logger.info('info 消息');
    logger.warn('warn 消息');
    logger.error('error 消息');

    expect(calls.length).toBe(2);
    expect(calls[0]).toBe('warn:warn 消息');
    expect(calls[1]).toBe('error:error 消息');
  });
});
