/**
 * 流水线编排器单元测试
 */

import { AnalysisPipeline } from '../../src/pipeline';
import { PipelineConfig } from '../../src/types';

// Mock 各阶段模块
jest.mock('../../src/extractor', () => ({
  Extractor: jest.fn().mockImplementation(() => ({
    extract: jest.fn().mockResolvedValue({
      account: { wxid: 'test_wxid', databases: [] },
      selectedDatabases: [{ type: 'MSG', path: '/test/MSG0.db' }],
    }),
  })),
}));

jest.mock('../../src/decryptor', () => ({
  Decryptor: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockResolvedValue({
      totalMessages: 100,
      outputPath: '/test/raw_messages.jsonl',
    }),
  })),
}));

jest.mock('../../src/normalizer', () => ({
  Normalizer: jest.fn().mockImplementation(() => ({
    normalize: jest.fn().mockResolvedValue([
      { talkerId: 'wxid_1', messages: [{}, {}] },
    ]),
  })),
}));

jest.mock('../../src/analyzer', () => ({
  Analyzer: jest.fn().mockImplementation(() => ({
    analyze: jest.fn().mockResolvedValue({
      success: [
        { talkerId: 'wxid_1', scores: { overall: 80 } },
      ],
      failed: [],
      stats: { totalSessions: 1, successCount: 1, failCount: 0 },
    }),
  })),
}));

jest.mock('../../src/persister', () => ({
  Persister: jest.fn().mockImplementation(() => ({
    persist: jest.fn().mockResolvedValue({
      filePaths: ['/test/output/results.csv'],
    }),
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    setLevel: jest.fn(),
    initLogFile: jest.fn().mockResolvedValue(undefined),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    clearTransports: jest.fn(),
    addTransport: jest.fn(),
  },
}));

describe('AnalysisPipeline', () => {
  const mockConfig: PipelineConfig = {
    extractor: {},
    decryptor: {
      toolType: 'pywxdump',
      pythonPath: 'python',
      pywxdumpModule: 'pywxdump',
      strategy: 'memory',
      outputDir: './temp/decrypted',
      concurrency: 3,
    },
    normalizer: {
      keepRawContent: true,
      cleaningRules: {
        removeControlChars: true,
        removeXmlTags: true,
        normalizeEmoji: true,
        trimWhitespace: true,
      },
    },
    analyzer: {
      llm: {
        provider: 'openai',
        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-test',
        primaryModel: 'gpt-4o',
        maxContextLength: 8000,
        temperature: 0.3,
        timeoutMs: 120000,
        maxRetries: 2,
      },
      concurrencyLimit: 3,
      compressionThreshold: 6000,
      batchSize: 10,
      enforceJsonMode: true,
      classification: {
        filterNonCustomers: true,
        minConfidence: 0.6,
      },
      validation: {
        enableRangeCheck: true,
        enableConsistencyCheck: true,
      },
    },
    exporter: {
      outputDir: './output',
      exportJsonl: true,
      exportCsv: true,
    },
    logLevel: 'info',
    tempDir: './temp',
  };

  it('应继承 EventEmitter', () => {
    const pipeline = new AnalysisPipeline(mockConfig);
    expect(pipeline.on).toBeDefined();
    expect(pipeline.emit).toBeDefined();
  });

  it('run() 应在各阶段 emit stage 事件', async () => {
    const pipeline = new AnalysisPipeline(mockConfig);
    const stageEvents: Array<{ name: string; percent: number }> = [];

    pipeline.on('stage', (stage) => {
      stageEvents.push({ name: stage.name, percent: stage.percent });
    });

    await pipeline.run();

    expect(stageEvents.length).toBeGreaterThanOrEqual(5);
    expect(stageEvents[0].name).toBe('extraction');
    expect(stageEvents[stageEvents.length - 1].name).toBe('persister');
  });

  it('run() 成功时应 emit complete 事件', async () => {
    const pipeline = new AnalysisPipeline(mockConfig);
    let completeResult: unknown = null;

    pipeline.on('complete', (result) => {
      completeResult = result;
    });

    const result = await pipeline.run();

    expect(result.success).toBe(true);
    expect(completeResult).not.toBeNull();
  });

  it('run() 失败时应 emit error 事件', async () => {
    const { Extractor } = require('../../src/extractor');
    Extractor.mockImplementationOnce(() => ({
      extract: jest.fn().mockRejectedValue(new Error('提取失败')),
    }));

    const pipeline = new AnalysisPipeline(mockConfig);
    let errorMessage: string | null = null;

    pipeline.on('error', (error) => {
      errorMessage = error;
    });

    const result = await pipeline.run();

    expect(result.success).toBe(false);
    expect(errorMessage).toBe('提取失败');
  });
});
