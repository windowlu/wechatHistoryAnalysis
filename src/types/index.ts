/**
 * 微信聊天记录分析系统 — 核心类型定义
 * 覆盖提取层、解密层、标准化层、分析层、持久层的全部数据接口
 */

// ═════════════════════════════════════════════════════════════════════════════
// 提取层类型
// ═════════════════════════════════════════════════════════════════════════════

/** 微信版本信息 */
export interface WeChatVersionInfo {
  version: string;
  installPath: string;
  dataPath: string;
}

/** 发现的微信账号 */
export interface WeChatAccount {
  wxid: string;
  alias?: string;
  nickname?: string;
  dataPath: string;
  databases: DatabaseFile[];
}

/** 数据库文件描述 */
export interface DatabaseFile {
  path: string;
  type: 'MSG' | 'MicroMsg' | 'Media' | 'Other';
  shardIndex?: number; // MSG0.db ~ MSG9.db 的索引
  size: number;
  mtime: Date;
}

/** 提取层配置 */
export interface ExtractorConfig {
  /** 手动指定微信数据目录（可选） */
  customDataPath?: string;
  /** 起始日期（含） */
  startDate?: Date;
  /** 结束日期（含） */
  endDate?: Date;
  /** 指定联系人/群聊ID过滤 */
  targetTalkers?: string[];
  /** 微信版本白名单 */
  allowedVersions?: string[];
}

/** 提取层输出 */
export interface ExtractionResult {
  account: WeChatAccount;
  selectedDatabases: DatabaseFile[];
  timeRange: { start: Date; end: Date };
  meta: {
    scannedAt: Date;
    wechatVersion?: string;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 解密层类型
// ═════════════════════════════════════════════════════════════════════════════

/** 解密策略 */
export type DecryptStrategy = 'memory' | 'cache' | 'manual';

/** 解密工具类型 */
export type DecryptToolType = 'generic' | 'pywxdump';

/** 解密层配置 */
export interface DecryptorConfig {
  /** 解密工具类型 */
  toolType: DecryptToolType;
  /** 通用解密工具可执行文件路径（toolType=generic 时使用） */
  decryptToolPath?: string;
  /** Python 可执行文件路径（toolType=pywxdump 时使用，默认 'python'） */
  pythonPath?: string;
  /** PyWxDump 模块名或入口路径（toolType=pywxdump 时使用，默认 'pywxdump'） */
  pywxdumpModule?: string;
  /** PyWxDump bias 额外参数（如 --deep, --multi） */
  pywxdumpBiasArgs?: string[];
  /** 优先使用的解密策略 */
  strategy: DecryptStrategy;
  /** 手动提供的密钥（策略为manual时使用） */
  manualKey?: string;
  /** 解密输出目录 */
  outputDir: string;
  /** 并行解密任务数 */
  concurrency: number;
}

/** 单条原始消息（解密层输出） */
export interface RawMessage {
  /** 消息唯一标识 */
  msgId: string;
  /** 消息SvrID */
  msgSvrId?: string;
  /** 所属会话ID */
  talkerId: string;
  /** 发送者wxid */
  senderId: string;
  /** 消息类型（微信原始数值编码） */
  type: number;
  /** 子类型 */
  subType?: number;
  /** 消息内容（原始文本/XML） */
  content: string;
  /** 创建时间戳（秒级Unix） */
  createTime: number;
  /** 序列号 */
  sequence?: number;
  /** 是否已发送 */
  isSend: boolean;
  /** 状态标记 */
  status?: number;
  /** 图片/文件路径 */
  mediaPath?: string;
  /** 消息额外数据 */
  extra?: Record<string, unknown>;
}

/** 解密层输出结果 */
export interface DecryptionResult {
  /** 输出文件路径（JSONL格式） */
  outputPath: string;
  /** 解密的消息总数 */
  totalMessages: number;
  /** 按数据库分片的统计 */
  shardStats: Array<{
    dbPath: string;
    messageCount: number;
  }>;
  /** 解密耗时(ms) */
  durationMs: number;
  /** 失败的数据库列表 */
  failedShards: string[];
}

// ═════════════════════════════════════════════════════════════════════════════
// 标准化层类型
// ═════════════════════════════════════════════════════════════════════════════

/** 业务可读的消息类型标签 */
export enum MessageType {
  TEXT = 'text',
  IMAGE = 'image',
  VOICE = 'voice',
  VIDEO = 'video',
  EMOJI = 'emoji',
  FILE = 'file',
  TRANSFER = 'transfer',
  RED_PACKET = 'red_packet',
  LINK_CARD = 'link_card',
  MINI_APP = 'mini_app',
  LOCATION = 'location',
  SYSTEM = 'system',
  REVOKE = 'revoke',
  QUOTE = 'quote',
  CALL = 'call',
  UNKNOWN = 'unknown',
}

/** 联系人信息 */
export interface ContactInfo {
  wxid: string;
  alias?: string;
  nickname: string;
  remark?: string;
  avatar?: string;
  type: 'user' | 'group' | 'official' | 'unknown';
}

/** 标准化后的消息对象 */
export interface NormalizedMessage {
  /** 消息唯一标识 */
  msgId: string;
  /** 所属会话ID */
  talkerId: string;
  /** 发送者wxid */
  senderId: string;
  /** 发送者信息（如可解析） */
  senderInfo?: ContactInfo;
  /** 业务类型 */
  type: MessageType;
  /** 子类型（细化描述） */
  subType?: string;
  /** 清洗后的纯文本内容 */
  content: string;
  /** 原始内容备份 */
  rawContent: string;
  /** ISO 8601格式时间 */
  timestamp: string;
  /** Unix时间戳（毫秒） */
  timestampMs: number;
  /** 是否当前账号发送 */
  isSelf: boolean;
  /** 媒体文件引用路径 */
  mediaRef?: string;
  /** 引用/回复的消息ID */
  quoteMsgId?: string;
  /** 群聊中@的成员列表 */
  atList?: string[];
  /** 额外结构化数据 */
  metadata?: Record<string, unknown>;
}

/** 标准化会话对象 */
export interface NormalizedSession {
  /** 会话ID */
  talkerId: string;
  /** 会话类型 */
  type: 'single' | 'group';
  /** 会话名称 */
  name: string;
  /** 参与者列表 */
  participants: ContactInfo[];
  /** 消息列表（按时间升序） */
  messages: NormalizedMessage[];
  /** 时间范围 */
  timeRange: { start: string; end: string };
  /** 消息统计 */
  stats: {
    total: number;
    selfCount: number;
    otherCount: number;
    typeDistribution: Record<MessageType, number>;
  };
}

/** 标准化层配置 */
export interface NormalizerConfig {
  /** 联系人数据库路径（用于补全信息） */
  contactDbPath?: string;
  /** 是否保留原始内容字段 */
  keepRawContent: boolean;
  /** 时区偏移（分钟） */
  timezoneOffset?: number;
  /** 内容清洗规则开关 */
  cleaningRules: {
    removeControlChars: boolean;
    removeXmlTags: boolean;
    normalizeEmoji: boolean;
    trimWhitespace: boolean;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 分析层类型
// ═════════════════════════════════════════════════════════════════════════════

/** 客户意向评级 */
export interface IntentRating {
  /** 评级分数 1-10 */
  score: number;
  /** 评级标签 */
  label: 'cold' | 'warm' | 'hot' | 'closed';
  /** 评级依据摘要 */
  reasoning: string;
}

/** 销售质量评分 */
export interface SalesQuality {
  /** 总分 1-10 */
  overallScore: number;
  /** 响应及时性 */
  responsiveness: number;
  /** 需求挖掘深度 */
  discoveryDepth: number;
  /** 价值传递清晰度 */
  valueClarity: number;
  /** 异议处理质量 */
  objectionHandling: number;
  /** 行动引导能力 */
  ctaEffectiveness: number;
  /** 改进建议 */
  suggestions: string[];
}

/** 待跟进事项 */
export interface FollowUpItem {
  /** 事项描述 */
  description: string;
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 建议截止日期 */
  suggestedDeadline?: string;
  /** 关联消息索引 */
  relatedMsgIndices: number[];
}

/** 情感趋势节点 */
export interface SentimentTrend {
  /** 节点时间 */
  timestamp: string;
  /** 情感分数 -1~1 */
  score: number;
  /** 情感标签 */
  label: 'positive' | 'neutral' | 'negative';
  /** 触发摘要 */
  trigger: string;
}

/** 风险标记 */
export interface RiskFlag {
  /** 风险类型 */
  type: 'complaint' | 'churn' | 'delay' | 'misunderstanding' | 'competitor' | 'other';
  /** 严重程度 */
  severity: 'critical' | 'warning' | 'info';
  /** 描述 */
  description: string;
  /** 关联消息索引 */
  relatedMsgIndices: number[];
}

/** 会话分析结果 */
export interface SessionAnalysis {
  /** 会话ID */
  talkerId: string;
  /** 会话名称 */
  talkerName: string;
  /** 客户画像 */
  customerProfile: {
    /** 客户角色/职位 */
    role?: string;
    /** 所属行业 */
    industry?: string;
    /** 公司规模 */
    companySize?: string;
    /** 核心需求摘要 */
    keyNeeds: string[];
    /** 决策阶段 */
    decisionStage?: string;
    /** 预算敏感度 */
    budgetSensitivity?: 'low' | 'medium' | 'high';
    /** 沟通风格 */
    communicationStyle?: string;
    /** 历史交互摘要 */
    interactionHistory: string;
  };
  /** 意向评级 */
  intentRating: IntentRating;
  /** 销售质量评分 */
  salesQuality: SalesQuality;
  /** 待跟进事项 */
  followUps: FollowUpItem[];
  /** 情感趋势 */
  sentimentTrends: SentimentTrend[];
  /** 风险标记 */
  riskFlags: RiskFlag[];
  /** 关键洞察 */
  keyInsights: string[];
  /** 会话摘要（50字内） */
  summary: string;
  /** 分析时间 */
  analyzedAt: string;
  /** 使用的模型 */
  model: string;
}

/** LLM配置 */
export interface LLMConfig {
  /** 提供商 */
  provider: 'openai' | 'anthropic' | 'local' | 'custom';
  /** API端点 */
  apiEndpoint: string;
  /** API密钥 */
  apiKey: string;
  /** 主模型名称 */
  primaryModel: string;
  /** 备用模型名称 */
  fallbackModel?: string;
  /** 最大上下文长度 */
  maxContextLength: number;
  /** 温度参数 */
  temperature: number;
  /** 请求超时(ms) */
  timeoutMs: number;
  /** 最大重试次数 */
  maxRetries: number;
}

/** 分析层配置 */
export interface AnalyzerConfig {
  /** LLM配置 */
  llm: LLMConfig;
  /** 并发上限 */
  concurrencyLimit: number;
  /** 会话上下文压缩阈值（token数） */
  compressionThreshold: number;
  /** 批次大小 */
  batchSize: number;
  /** 是否启用JSON模式强制输出 */
  enforceJsonMode: boolean;
  /** 输出校验开关 */
  validation: {
    enableRangeCheck: boolean;
    enableConsistencyCheck: boolean;
  };
}

/** 分析执行结果 */
export interface AnalysisResult {
  /** 成功分析的会话 */
  success: SessionAnalysis[];
  /** 失败的会话 */
  failed: Array<{
    talkerId: string;
    reason: string;
    retryable: boolean;
  }>;
  /** 执行统计 */
  stats: {
    totalSessions: number;
    successCount: number;
    failCount: number;
    totalDurationMs: number;
    avgDurationMs: number;
    tokenUsage?: { prompt: number; completion: number };
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 持久层类型
// ═════════════════════════════════════════════════════════════════════════════

/** 导出配置 */
export interface ExportConfig {
  /** 输出目录 */
  outputDir: string;
  /** 是否导出JSONL */
  exportJsonl: boolean;
  /** 是否导出CSV */
  exportCsv: boolean;
}

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 流水线完整配置 */
export interface PipelineConfig {
  /** 提取层配置 */
  extractor: ExtractorConfig;
  /** 解密层配置 */
  decryptor: DecryptorConfig;
  /** 标准化层配置 */
  normalizer: NormalizerConfig;
  /** 分析层配置 */
  analyzer: AnalyzerConfig;
  /** 持久层配置 */
  exporter: ExportConfig;
  /** 全局日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 临时目录 */
  tempDir: string;
}

/** 流水线执行结果 */
export interface PipelineResult {
  /** 是否整体成功 */
  success: boolean;
  /** 各阶段结果 */
  stages: {
    extraction?: ExtractionResult;
    decryption?: DecryptionResult;
    normalization?: { sessionCount: number; messageCount: number };
    analysis?: AnalysisResult;
    export?: { filePaths: string[] };
  };
  /** 执行统计 */
  stats: {
    startTime: Date;
    endTime: Date;
    durationMs: number;
  };
  /** 错误信息（如有） */
  error?: string;
}
