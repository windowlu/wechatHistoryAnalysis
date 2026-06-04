# 微信聊天记录一键静态分析系统

> **版本**: v1.0 | **日期**: 2026-06-04 | **适用场景**: 销售对话智能分析（静态离线模式）

---

## 一、项目概述

### 1.1 背景与目标

本系统面向销售团队与业务管理者，提供**一键式**的微信聊天记录分析能力。用户仅需在本地点击一次按钮（或执行一条命令），系统即可自动完成从原始加密数据库到结构化分析报告的全流程转换——无需常驻后台服务、无需文件监控、无需实时网络推送。

### 1.2 核心场景

- **销售复盘**：销售管理者定期回顾团队与客户的沟通记录，识别客户意向度、销售话术质量、待跟进事项与风险信号。
- **客户画像沉淀**：将分散在个体销售微信中的对话资产，转化为可检索、可分析的结构化数据，避免人员流动导致的客户信息流失。

### 1.3 设计原则

| 原则 | 说明 |
|------|------|
| **命令式触发** | 整个流程由用户主动发起，执行完毕后即退出，不驻留内存，不监听文件系统变化 |
| **静态离线优先** | 所有数据处理均在本地完成，原始聊天记录不出境、不上云；LLM分析按会话批次传输，最小化数据暴露面 |
| **管道化架构** | 提取、解密、分析、导出四个阶段严格解耦，每阶段输出标准中间格式，便于单点调试、替换与扩展 |

---

## 二、系统架构

系统由五个顺序执行的层级构成，形成单向流水线：

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   提取层    │───→│   解密层    │───→│  标准化层   │───→│   分析层    │───→│   持久层    │
│ Extractor   │    │ Decryptor   │    │ Normalizer  │    │  Analyzer   │    │ Persister   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### 各层职责

| 层级 | 职责 | 输出格式 |
|------|------|----------|
| **提取层** | 自动定位微信PC端数据库文件，校验完整性，按时间/联系人范围筛选 | 数据库文件路径列表 |
| **解密层** | 从微信进程/本地缓存获取SQLCipher密钥，批量解密消息数据库 | JSONL（原始消息流） |
| **标准化层** | 清洗、去重、类型识别、群聊成员解析、时间戳对齐 | 标准化会话对象数组 |
| **分析层** | 按会话维度调用LLM进行智能分析 | 结构化分析结果（JSON） |
| **持久层** | 导出JSONL/CSV/HTML报告，可选回写PostgreSQL/pgvector | 多格式本地文件 |

---

## 三、功能特性

### 3.1 提取层

- **自动发现**：扫描 `Documents\WeChat Files` 目录，自动识别以 `wxid_` 为前缀的账号文件夹
- **范围限定**：支持按起始/结束日期筛选MSG分片数据库，按联系人/群聊ID前置过滤
- **版本兼容**：维护路径解析表覆盖3.9.x/3.8.x主流版本，未知版本降级为手动选择

### 3.2 解密层

- **密钥获取策略**：优先从微信进程内存提取实时密钥（无需密码），失败则回退至本地缓存或手动输入
- **子进程隔离**：解密以独立子进程运行，与主分析进程隔离，只读模式不修改原始数据库
- **增量识别**：输出附带每条消息的 `MsgId` 与时间戳，供下游去重

### 3.3 标准化层

- **消息类型映射**：将微信内部数值编码转译为业务可读标签（文本、图片、语音、转账、系统通知等）
- **群聊成员解析**：通过正则提取 `@wxid_xxx:\n` 前缀，补全发送者信息
- **时间对齐**：统一秒级/毫秒级/本地时间字符串为ISO 8601格式
- **内容清洗**：去除控制字符、XML标签、表情编码，保留原始字段备份

### 3.4 分析层

- **会话分片**：按会话ID分组分析，超长会话自动上下文压缩（保留首尾+关键转折点）
- **六维分析**：客户画像、意向评级、销售质量评分、待跟进事项、情感趋势、风险标记
- **并发控制**：可配置并发上限与批次大小，防止API限流与内存溢出
- **降级策略**：主模型失败自动切换备用轻量模型，输出核心字段确保流水线不中断
- **输出校验**：数值范围校验 + 一致性检查（如意向与需求表达矛盾检测）

### 3.5 持久层

- **JSONL**：面向机器消费，每行完整分析对象，保留全部嵌套结构
- **CSV**：字段扁平化，Excel/WPS直接打开，快速筛选排序
- **HTML报告**：单页应用形态，内置可视化图表与关键洞察高亮，离线可打开
- **数据库（可选）**：PostgreSQL + pgvector，支持JSONB灵活查询与Embedding相似度检索

---

## 四、快速开始

### 4.1 环境要求

- **Node.js** >= 18.0.0
- **操作系统**：Windows（微信PC端所在系统）
- **LLM API密钥**：OpenAI / Anthropic / 兼容OpenAI格式的自定义端点

### 4.2 安装

```bash
# 克隆项目
git clone <repo-url>
cd wechat-history-analysis

# 安装依赖
npm install

# 编译TypeScript
npm run build
```

### 4.3 配置

复制示例配置文件并填入实际参数：

```bash
cp config.example.json config.json
```

编辑 `config.json`，重点关注以下字段：

```json
{
  "extractor": {
    "customDataPath": "C:\\Users\\YOUR_NAME\\Documents\\WeChat Files"
  },
  "decryptor": {
    "decryptToolPath": "./bin/decrypt-tool.exe",
    "strategy": "memory"
  },
  "analyzer": {
    "llm": {
      "apiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "primaryModel": "gpt-4o",
      "fallbackModel": "gpt-4o-mini"
    }
  }
}
```

> **注意**: `decryptToolPath` 指向外部解密工具可执行文件。项目不包含解密工具本身，需自行准备（如基于 `wechatDataBackup` 或 `PyWxDump` 编译/提取）。

### 4.4 运行分析

```bash
# 使用配置文件
npm start -- analyze --config config.json

# 命令行参数直接运行
npm start -- analyze \
  --data-path "C:\\Users\\YOUR_NAME\\Documents\\WeChat Files" \
  --llm-key "sk-xxxxxxxx" \
  --llm-model "gpt-4o" \
  --output "./output" \
  --start-date "2025-01-01" \
  --end-date "2025-12-31"

# 查看帮助
npm start -- --help
```

### 4.5 输出示例

分析完成后，`output/` 目录将生成：

```
output/
├── analysis_results.jsonl   # 机器可读完整数据
├── analysis_results.csv     # Excel可打开的扁平化表格
├── report.html              # 可视化报告（双击浏览器打开）
└── analysis_20260604.log    # 执行日志
```

---

## 五、项目结构

```
wechat-history-analysis/
├── src/
│   ├── extractor/           # 提取层 — 微信数据目录扫描与数据库定位
│   ├── decryptor/           # 解密层 — SQLCipher密钥获取与批量解密
│   ├── normalizer/          # 标准化层 — 消息清洗、类型映射、时间对齐
│   ├── analyzer/            # 分析层 — LLM调用、提示词、输出校验
│   │   ├── prompts.ts       # 分析/降级提示词模板
│   │   └── validator.ts     # 输出数值范围与一致性校验
│   ├── persister/           # 持久层 — JSONL/CSV/HTML导出、数据库写入
│   ├── types/               # 全系统TypeScript类型定义
│   ├── utils/               # 工具函数
│   │   ├── logger.ts        # 分级日志
│   │   ├── stream-helper.ts # 大文件流式处理、LRU缓存
│   │   └── path-resolver.ts # 微信路径解析与版本兼容
│   ├── pipeline.ts          # 流水线编排器 — 五层协调与错误隔离
│   └── cli.ts               # CLI入口
├── templates/
│   └── report.ejs           # HTML报告EJS模板
├── tests/
│   └── unit/                # 单元测试
├── bin/                     # 外部解密工具（需自行放置）
├── config.example.json      # 示例配置文件
├── package.json
├── tsconfig.json
└── README.md
```

---

## 六、配置详解

### 6.1 提取层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `customDataPath` | string | 自动检测 | 手动指定微信数据目录 |
| `startDate` | Date | — | 起始日期（含） |
| `endDate` | Date | — | 结束日期（含） |
| `targetTalkers` | string[] | — | 指定联系人/群聊ID过滤 |
| `allowedVersions` | string[] | `["3.9.x","3.8.x"]` | 微信版本白名单 |

### 6.2 解密层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `decryptToolPath` | string | `./bin/decrypt-tool` | 解密工具可执行文件路径 |
| `strategy` | string | `memory` | 密钥策略：`memory`/`cache`/`manual` |
| `manualKey` | string | — | 手动密钥（strategy=manual时使用） |
| `concurrency` | number | 3 | 并行解密任务数 |

### 6.3 标准化层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `keepRawContent` | boolean | true | 是否保留原始内容字段 |
| `timezoneOffset` | number | 系统时区 | 时区偏移（分钟） |
| `cleaningRules` | object | — | 内容清洗规则开关 |

### 6.4 分析层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `llm.apiEndpoint` | string | OpenAI官方 | LLM API端点 |
| `llm.apiKey` | string | — | API密钥（**必填**） |
| `llm.primaryModel` | string | `gpt-4o` | 主模型 |
| `llm.fallbackModel` | string | `gpt-4o-mini` | 备用降级模型 |
| `concurrencyLimit` | number | 3 | 分析并发上限 |
| `compressionThreshold` | number | 6000 | 上下文压缩阈值（估算token数） |
| `batchSize` | number | 10 | 每批处理会话数 |
| `enforceJsonMode` | boolean | true | 强制JSON模式输出 |

### 6.5 持久层配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `outputDir` | string | `./output` | 输出目录 |
| `exportJsonl` | boolean | true | 导出JSONL |
| `exportCsv` | boolean | true | 导出CSV |
| `exportHtml` | boolean | true | 导出HTML报告 |
| `writeToDatabase` | boolean | false | 写入PostgreSQL |

---

## 七、开发指南

### 7.1 本地开发

```bash
# 开发模式运行
npm run dev -- analyze --config config.json

# 运行测试
npm test

# 代码检查
npm run lint

# 清理构建产物
npm run clean
```

### 7.2 添加新的消息类型映射

编辑 `src/normalizer/index.ts` 中的 `WECHAT_TYPE_MAP`：

```typescript
const WECHAT_TYPE_MAP: Record<number, MessageType> = {
  1: MessageType.TEXT,
  3: MessageType.IMAGE,
  // ... 在此处添加新的映射
  999: MessageType.YOUR_NEW_TYPE,
};
```

### 7.3 自定义分析提示词

编辑 `src/analyzer/prompts.ts` 中的 `ANALYSIS_PROMPT` 和 `FALLBACK_PROMPT`，可调整：
- 分析维度与字段定义
- 评分细则与扣分项
- 输出JSON的Schema结构

### 7.4 接入其他LLM提供商

只要API兼容OpenAI Chat Completions格式，修改 `analyzer.llm.apiEndpoint` 即可接入：
- Azure OpenAI
- 通义千问 / 文心一言 / 智谱（OpenAI兼容模式）
- 本地部署的 vLLM / Ollama

---

## 八、注意事项与风险

### 8.1 微信版本兼容性

微信PC端更新频繁，数据库加密参数、密钥派生逻辑、文件路径均可能变化。**解密层已严格隔离为独立子进程与独立代码仓库**，版本适配时仅需替换可执行文件，不影响主分析流程。建议建立微信版本白名单机制。

### 8.2 数据隐私与合规

- 所有解密与分析均在**本地完成**，原始数据库文件不离开用户设备
- LLM分析阶段仅传输**单会话文本**，不包含头像、文件、语音二进制数据
- 分析结果默认保存在**用户指定的本地目录**，不上传云端
- **请勿将分析结果提交至Git或共享至公共平台**

### 8.3 模型输出稳定性

LLM分析长对话时可能出现幻觉、格式偏离或评分标准漂移。系统已内置以下规避策略：
- 系统提示词中严格定义输出Schema与评分细则
- 启用JSON模式强制结构化输出
- 关键字段设置数值范围校验与异常值拦截
- 引入轻量级规则引擎作为后校验层

### 8.4 大数据量内存管理

全流程采用**流式处理**，从解密输出到标准化再到分析分组，均使用逐行读取与分批次加载，避免一次性载入全部数据。会话分组阶段使用内存LRU缓存，确保内存占用可控。

---

## 九、MVP实施路径

| 阶段 | 目标 | 产出 |
|------|------|------|
| **Phase 1** | 验证解密可行性 | 使用开源工具手动导出，确认数据库可解密、字段可读取 |
| **Phase 2** | 搭建标准化管道 | Node.js清洗脚本，验证群聊解析、时间对齐、类型映射 |
| **Phase 3** | 接入LLM分析 | 代表性会话提示词调优，人工校验评分合理性与JSON稳定性 |
| **Phase 4** | 一键封装 | CLI命令整合，自动执行、多格式导出 |

---

## 十、技术栈

| 层级 | 技术 |
|------|------|
| 主进程 | Node.js + TypeScript |
| 解密工具 | Go / Python（外部可执行文件） |
| 报告生成 | EJS + Tailwind CSS（CDN内联） |
| 数据存储 | PostgreSQL + pgvector（可选） |
| LLM调用 | OpenAI兼容API |
| 测试 | Jest + ts-jest |

---

## 十一、开源协议

MIT License

---

## 十二、附录

### 12.1 微信数据库文件说明

| 文件 | 说明 |
|------|------|
| `MSG0.db` ~ `MSG9.db` | 聊天消息主体数据库，按时间/账号分片 |
| `MicroMsg.db` | 联系人、群信息、公众号列表、头像缓存索引 |
| `FileStorage/` | 图片、视频、文件、语音二进制缓存 |

### 12.2 消息类型速查

| 类型编码 | 类型 | 处理方式 |
|----------|------|----------|
| 1 | 文本 | 主要分析输入源 |
| 3 | 图片 | 结构化描述 + 保留引用路径 |
| 34 | 语音 | 结构化描述 + 保留引用路径 |
| 43 | 视频 | 结构化描述 + 保留引用路径 |
| 47 | 表情/动图 | 结构化描述 |
| 49 | 转账/红包/链接/小程序 | 根据内容XML推断子类型 |
| 10000 | 系统提示 | 入群通知、撤回提示等 |

---

> 本系统仅供合法授权的本地数据分析使用，请遵守相关法律法规与微信用户协议。
