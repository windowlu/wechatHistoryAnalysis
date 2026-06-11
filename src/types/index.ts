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
// 分析层类型（客户识别与分类系统）
// ═════════════════════════════════════════════════════════════════════════════

/** 联系人分类结果 */
export interface ContactClassification {
  /** 是否为客户 */
  isCustomer: boolean;
  /** 客户类型 */
  customerType?: 'b2b' | 'b2c';
  /** 客户子类型（更细分） */
  subType?: string;
  /** 分类置信度 0-1 */
  confidence: number;
  /** 分类理由 */
  reasoning: string;
}

/** B端客户关键信息 */
export interface B2BCustomerInfo {
  /** 公司名称 */
  companyName?: string;
  /** 联系人姓名 */
  contactName?: string;
  /** 联系人职位/角色 */
  contactRole?: string;
  /** 需求类型 */
  demandType?: string;
  /** 具体需求描述 */
  demandDetail?: string;
  /** 公司/项目地区 */
  region?: string;
  /** 紧急程度 */
  urgency?: 'high' | 'medium' | 'low';
  /** 预算范围 */
  budgetRange?: string;
  /** 跟进状态 */
  followUpStatus?: 'new' | 'contacted' | 'quoted' | 'negotiating' | 'closed';
  /** 关联的项目/资质类型 */
  projectTypes?: string[];
}

/** C端客户关键信息 */
export interface B2CCustomerInfo {
  /** 客户姓名 */
  name?: string;
  /** 考试类型 */
  examType?: string;
  /** 报考年份/计划 */
  examYear?: string;
  /** 需求类型 */
  demandType?: string;
  /** 专业方向 */
  major?: string;
  /** 地区 */
  region?: string;
  /** 学习阶段 */
  studyStage?: string;
  /** 购买记录 */
  purchaseHistory?: string[];
  /** 跟进状态 */
  followUpStatus?: 'new' | 'interested' | 'purchased' | 'inactive';
}

/** 会话分析结果（客户识别版） */
export interface SessionAnalysis {
  /** 会话ID */
  talkerId: string;
  /** 会话名称 */
  talkerName: string;
  /** 分类结果 */
  classification: ContactClassification;
  /** 客户关键信息（仅对客户填充） */
  customerInfo?: B2BCustomerInfo | B2CCustomerInfo;
  /** 关键洞察 */
  keyInsights: string[];
  /** 最后活跃时间 */
  lastActiveAt: string;
  /** 消息总数 */
  messageCount: number;
  /** 分析时间 */
  analyzedAt: string;
  /** 使用的模型 */
  model: string;
}

/** LLM配置 */
export interface LLMConfig {
  /** 提供商 */
  provider: 'openai' | 'anthropic' | 'local' | 'custom' | 'kimi';
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

/** 客户识别配置 */
export interface ClassificationConfig {
  /** 过滤非客户（只保留客户） */
  filterNonCustomers: boolean;
  /** 最低分类置信度阈值（低于此值标记为不确定） */
  minConfidence: number;
  /** 目标客户类型（null=全部） */
  targetCustomerType?: 'b2b' | 'b2c';
  /** 只分析最近 N 天内有聊天的会话（0 或空表示全量） */
  lookbackDays?: number;
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
  /** 客户识别配置 */
  classification: ClassificationConfig;
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
    customerCount: number;
    b2bCount: number;
    b2cCount: number;
    nonCustomerCount: number;
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
