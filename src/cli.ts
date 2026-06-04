#!/usr/bin/env node
/**
 * CLI入口
 * 提供一键触发分析流水线的命令行接口
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PipelineConfig, LogLevel } from './types';
import { AnalysisPipeline } from './pipeline';
import { logger } from './utils/logger';

const program = new Command();

program
  .name('wechat-analysis')
  .description('微信聊天记录一键静态分析系统')
  .version('1.0.0');

program
  .command('analyze')
  .description('执行完整的微信聊天记录分析')
  .option('-d, --data-path <path>', '指定微信数据目录')
  .option('-s, --start-date <date>', '起始日期 (YYYY-MM-DD)')
  .option('-e, --end-date <date>', '结束日期 (YYYY-MM-DD)')
  .option('-o, --output <dir>', '输出目录', './output')
  .option('-t, --temp <dir>', '临时目录', './temp')
  .option('--decrypt-tool <path>', '解密工具路径', './bin/decrypt-tool')
  .option('--llm-endpoint <url>', 'LLM API端点')
  .option('--llm-key <key>', 'LLM API密钥')
  .option('--llm-model <model>', '主模型名称', 'gpt-4o')
  .option('--llm-fallback <model>', '备用模型名称', 'gpt-4o-mini')
  .option('--concurrency <n>', '并发数', '3')
  .option('--batch-size <n>', '批次大小', '10')
  .option('--no-html', '不导出HTML报告')
  .option('--no-csv', '不导出CSV')
  .option('--no-jsonl', '不导出JSONL')
  .option('--log-level <level>', '日志级别 (debug|info|warn|error)', 'info')
  .option('--config <path>', '配置文件路径')
  .action(async (options) => {
    try {
      // 加载配置文件（如提供）
      let config: Partial<PipelineConfig> = {};
      if (options.config && (await fs.pathExists(options.config))) {
        const configContent = await fs.readFile(options.config, 'utf-8');
        config = JSON.parse(configContent);
      }

      // 解析日期
      const startDate = options.startDate ? new Date(options.startDate) : undefined;
      const endDate = options.endDate ? new Date(options.endDate) : undefined;

      // 构建完整配置
      const pipelineConfig: PipelineConfig = {
        extractor: {
          customDataPath: options.dataPath || config.extractor?.customDataPath,
          startDate: startDate || config.extractor?.startDate,
          endDate: endDate || config.extractor?.endDate,
          targetTalkers: config.extractor?.targetTalkers,
          allowedVersions: config.extractor?.allowedVersions || ['3.9.x', '3.8.x'],
        },
        decryptor: {
          decryptToolPath: options.decryptTool || config.decryptor?.decryptToolPath || './bin/decrypt-tool',
          strategy: config.decryptor?.strategy || 'memory',
          outputDir: path.join(options.temp || config.tempDir || './temp', 'decrypted'),
          concurrency: config.decryptor?.concurrency || 3,
        },
        normalizer: {
          keepRawContent: config.normalizer?.keepRawContent ?? true,
          timezoneOffset: config.normalizer?.timezoneOffset,
          cleaningRules: {
            removeControlChars: config.normalizer?.cleaningRules?.removeControlChars ?? true,
            removeXmlTags: config.normalizer?.cleaningRules?.removeXmlTags ?? true,
            normalizeEmoji: config.normalizer?.cleaningRules?.normalizeEmoji ?? true,
            trimWhitespace: config.normalizer?.cleaningRules?.trimWhitespace ?? true,
          },
        },
        analyzer: {
          llm: {
            provider: config.analyzer?.llm?.provider || 'openai',
            apiEndpoint:
              options.llmEndpoint ||
              config.analyzer?.llm?.apiEndpoint ||
              'https://api.openai.com/v1/chat/completions',
            apiKey: options.llmKey || config.analyzer?.llm?.apiKey || '',
            primaryModel: options.llmModel || config.analyzer?.llm?.primaryModel || 'gpt-4o',
            fallbackModel: options.llmFallback || config.analyzer?.llm?.fallbackModel,
            maxContextLength: config.analyzer?.llm?.maxContextLength || 8000,
            temperature: config.analyzer?.llm?.temperature ?? 0.3,
            timeoutMs: config.analyzer?.llm?.timeoutMs || 120000,
            maxRetries: config.analyzer?.llm?.maxRetries || 2,
          },
          concurrencyLimit: parseInt(options.concurrency, 10) || config.analyzer?.concurrencyLimit || 3,
          compressionThreshold: config.analyzer?.compressionThreshold || 6000,
          batchSize: parseInt(options.batchSize, 10) || config.analyzer?.batchSize || 10,
          enforceJsonMode: config.analyzer?.enforceJsonMode ?? true,
          validation: {
            enableRangeCheck: config.analyzer?.validation?.enableRangeCheck ?? true,
            enableConsistencyCheck: config.analyzer?.validation?.enableConsistencyCheck ?? true,
          },
        },
        exporter: {
          outputDir: options.output || config.exporter?.outputDir || './output',
          exportJsonl: options.jsonl !== false && (config.exporter?.exportJsonl ?? true),
          exportCsv: options.csv !== false && (config.exporter?.exportCsv ?? true),
          exportHtml: options.html !== false && (config.exporter?.exportHtml ?? true),
          htmlTitle: config.exporter?.htmlTitle || '微信聊天记录分析报告',
          writeToDatabase: config.exporter?.writeToDatabase || false,
          database: config.exporter?.database,
          vector: config.exporter?.vector,
        },
        logLevel: (options.logLevel as LogLevel) || config.logLevel || 'info',
        tempDir: options.temp || config.tempDir || './temp',
      };

      // 校验LLM密钥
      if (!pipelineConfig.analyzer.llm.apiKey) {
        console.error('错误: 未提供LLM API密钥，请使用 --llm-key 参数或配置文件指定');
        process.exit(1);
      }

      // 设置日志级别
      logger.setLevel(pipelineConfig.logLevel);

      // 确保目录存在
      await fs.ensureDir(pipelineConfig.exporter.outputDir);
      await fs.ensureDir(pipelineConfig.tempDir);

      // 执行流水线
      const pipeline = new AnalysisPipeline(pipelineConfig);
      const result = await pipeline.run();

      if (result.success) {
        console.log('\n✓ 分析完成');
        if (result.stages.export) {
          console.log('输出文件:');
          for (const fp of result.stages.export.filePaths) {
            console.log(`  ${fp}`);
          }
        }
        process.exit(0);
      } else {
        console.error(`\n✗ 分析失败: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`未捕获的错误: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('retry')
  .description('对失败会话进行二次分析')
  .requiredOption('-f, --failed-file <path>', '失败会话清单文件路径')
  .option('-c, --config <path>', '配置文件路径')
  .action(async (options) => {
    try {
      // 读取失败会话清单
      const failedContent = await fs.readFile(options.failedFile, 'utf-8');
      const failedIds = failedContent
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);

      if (failedIds.length === 0) {
        console.error('错误: 失败会话清单为空');
        process.exit(1);
      }

      // 加载配置
      let config: Partial<PipelineConfig> = {};
      if (options.config && (await fs.pathExists(options.config))) {
        const configContent = await fs.readFile(options.config, 'utf-8');
        config = JSON.parse(configContent);
      }

      console.log(`重试 ${failedIds.length} 个失败会话...`);
      // TODO: 实现retry逻辑，需要加载之前的结果对象
      console.log('请使用 analyze 命令配合 --target-talkers 参数进行定向重试');
    } catch (err) {
      console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program.parse();
