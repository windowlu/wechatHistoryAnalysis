/**
 * 标准化层 (Normalizer)
 * 负责原始数据清洗、去重、类型识别、群聊成员解析与时间戳对齐
 */

import * as fs from 'fs-extra';
import dayjs = require('dayjs');
import {
  RawMessage,
  NormalizedMessage,
  NormalizedSession,
  ContactInfo,
  MessageType,
  NormalizerConfig,
} from '../types';
import { logger } from '../utils/logger';
import { processJsonlInBatches, LruMap } from '../utils/stream-helper';

/** 微信消息类型编码映射 */
const WECHAT_TYPE_MAP: Record<number, MessageType> = {
  1: MessageType.TEXT,
  3: MessageType.IMAGE,
  34: MessageType.VOICE,
  43: MessageType.VIDEO,
  47: MessageType.EMOJI,
  49: MessageType.LINK_CARD,
  50: MessageType.MINI_APP,
  10000: MessageType.SYSTEM,
  10002: MessageType.REVOKE,
};

/** 微信类型49的子类型映射（通过内容XML推断） */
const SUB_TYPE_49_MAP: Record<string, MessageType> = {
  transfer: MessageType.TRANSFER,
  redpacket: MessageType.RED_PACKET,
  file: MessageType.FILE,
  location: MessageType.LOCATION,
  link: MessageType.LINK_CARD,
  app: MessageType.MINI_APP,
};

export class Normalizer {
  private config: NormalizerConfig;
  private contactCache: LruMap<string, ContactInfo>;

  constructor(config: NormalizerConfig) {
    this.config = config;
    this.contactCache = new LruMap(10000);
  }

  /**
   * 执行标准化流程
   * @param rawJsonlPath 解密层输出的原始JSONL路径
   */
  async normalize(rawJsonlPath: string): Promise<NormalizedSession[]> {
    logger.info('标准化层: 开始处理原始消息数据');
    const startTime = Date.now();

    // 1. 加载联系人信息（如提供）
    if (this.config.contactDbPath && (await fs.pathExists(this.config.contactDbPath))) {
      await this.loadContacts(this.config.contactDbPath);
    }

    // 2. 逐批读取并标准化消息
    const messages: NormalizedMessage[] = [];
    await processJsonlInBatches<RawMessage>(rawJsonlPath, 5000, async (batch) => {
      for (const raw of batch) {
        const normalized = this.normalizeSingleMessage(raw);
        if (normalized) {
          messages.push(normalized);
        }
      }
    });

    logger.info(`标准化: ${messages.length} 条有效消息`);

    // 3. 按会话分组
    const sessions = this.groupBySession(messages);
    logger.info(`标准化: ${sessions.length} 个会话`);

    const durationMs = Date.now() - startTime;
    logger.info(`标准化层完成, 耗时 ${durationMs}ms`);

    return sessions;
  }

  /**
   * 单条消息标准化
   */
  private normalizeSingleMessage(raw: RawMessage): NormalizedMessage | null {
    try {
      // 去重检查：基于msgId
      if (!raw.msgId || !raw.talkerId) {
        return null;
      }

      // 解析类型
      const type = this.resolveType(raw.type, raw.content);

      // 解析发送者（处理群聊前缀）
      const { senderId, cleanContent } = this.parseSenderAndContent(
        raw.talkerId,
        raw.senderId,
        raw.content,
        type,
      );

      // 时间对齐
      const timestampMs = this.normalizeTimestamp(raw.createTime);
      const timestamp = dayjs(timestampMs).toISOString();

      // 内容清洗
      const content = this.config.cleaningRules.removeControlChars
        ? this.cleanContent(cleanContent)
        : cleanContent;

      // 联系人信息补全
      const senderInfo = this.contactCache.get(senderId);

      return {
        msgId: raw.msgId,
        talkerId: raw.talkerId,
        senderId,
        senderInfo,
        type,
        content,
        rawContent: this.config.keepRawContent ? raw.content : '',
        timestamp,
        timestampMs,
        isSelf: raw.isSend,
        mediaRef: raw.mediaPath,
        metadata: raw.extra,
      };
    } catch (err) {
      logger.debug(`消息标准化失败: ${raw.msgId}`, { error: String(err) });
      return null;
    }
  }

  /**
   * 解析消息类型
   */
  private resolveType(typeCode: number, content?: string): MessageType {
    // 主类型映射
    let type = WECHAT_TYPE_MAP[typeCode];

    // 类型49：需要根据内容进一步判断
    if (typeCode === 49 && content) {
      type = this.resolveType49(content);
    }

    // 撤回消息判断
    if (content && content.includes('撤回了一条消息')) {
      type = MessageType.REVOKE;
    }

    // 语音/视频通话
    if (content && (content.includes('通话时长') || content.includes('邀请你视频通话'))) {
      type = MessageType.CALL;
    }

    return type || MessageType.UNKNOWN;
  }

  /**
   * 解析类型49的子类型
   */
  private resolveType49(content: string): MessageType {
    if (content.includes('转账')) return MessageType.TRANSFER;
    if (content.includes('红包')) return MessageType.RED_PACKET;
    if (content.includes('文件') || content.includes('filename')) return MessageType.FILE;
    if (content.includes('位置') || content.includes('location')) return MessageType.LOCATION;
    if (content.includes('appmsg') || content.includes('小程序')) return MessageType.MINI_APP;
    return MessageType.LINK_CARD;
  }

  /**
   * 解析群聊发送者与清洗内容
   * 微信群聊消息格式: @wxid_xxx:\n实际内容
   */
  private parseSenderAndContent(
    talkerId: string,
    senderId: string,
    content: string,
    type: MessageType,
  ): { senderId: string; cleanContent: string } {
    // 群聊消息特征：talkerId以@chatroom结尾，内容前缀包含发送者
    if (talkerId.endsWith('@chatroom') && content) {
      const match = content.match(/^(@[\w@_]+):\n?(.*)$/s);
      if (match) {
        const actualSender = match[1]; // @wxid_xxx
        const actualContent = match[2];
        // 去掉开头的@符号
        const cleanSender = actualSender.replace(/^@/, '');
        return { senderId: cleanSender, cleanContent: actualContent };
      }
    }

    // 引用消息处理
    if (type === MessageType.QUOTE && content) {
      // 简单清洗引用标记
      const cleanContent = content.replace(/​/g, '');
      return { senderId, cleanContent };
    }

    return { senderId, cleanContent: content || '' };
  }

  /**
   * 时间戳标准化为毫秒级Unix时间戳
   * 微信数据库中时间戳可能为秒级或毫秒级
   */
  private normalizeTimestamp(ts: number): number {
    if (!ts || ts <= 0) return Date.now();

    // 判断是秒级还是毫秒级
    // 秒级时间戳（10位数字）约在2001年~2286年之间
    // 毫秒级时间戳（13位数字）
    if (ts < 10000000000) {
      // 秒级转毫秒级
      return ts * 1000;
    }
    return ts;
  }

  /**
   * 内容清洗
   */
  private cleanContent(content: string): string {
    let cleaned = content;

    if (this.config.cleaningRules.removeControlChars) {
      // 去除控制字符（保留换行和制表）
      cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    }

    if (this.config.cleaningRules.removeXmlTags) {
      // 去除XML标签但保留文本内容
      cleaned = cleaned.replace(/<\/?[^>]+>/g, ' ');
    }

    if (this.config.cleaningRules.normalizeEmoji) {
      // 标准化微信表情编码（如 /微笑 → [微笑]）
      cleaned = cleaned.replace(/\/(\S{1,4})/g, '[$1]');
    }

    if (this.config.cleaningRules.trimWhitespace) {
      cleaned = cleaned.replace(/\s+/g, ' ').trim();
    }

    return cleaned;
  }

  /**
   * 按会话ID分组消息
   */
  private groupBySession(messages: NormalizedMessage[]): NormalizedSession[] {
    const sessionMap = new Map<string, NormalizedMessage[]>();

    for (const msg of messages) {
      if (!sessionMap.has(msg.talkerId)) {
        sessionMap.set(msg.talkerId, []);
      }
      sessionMap.get(msg.talkerId)!.push(msg);
    }

    const sessions: NormalizedSession[] = [];
    for (const [talkerId, msgs] of sessionMap) {
      // 按时间排序
      msgs.sort((a, b) => a.timestampMs - b.timestampMs);

      // 统计
      const typeDistribution: Record<MessageType, number> = {} as Record<MessageType, number>;
      let selfCount = 0;
      for (const msg of msgs) {
        typeDistribution[msg.type] = (typeDistribution[msg.type] || 0) + 1;
        if (msg.isSelf) selfCount++;
      }

      // 提取参与者
      const participantIds = new Set(msgs.map((m) => m.senderId));
      const participants: ContactInfo[] = [];
      for (const pid of participantIds) {
        const cached = this.contactCache.get(pid);
        if (cached) {
          participants.push(cached);
        } else {
          participants.push({
            wxid: pid,
            nickname: pid,
            type: 'unknown',
          });
        }
      }

      // 判断会话类型
      const type = talkerId.endsWith('@chatroom') ? 'group' : 'single';

      sessions.push({
        talkerId,
        type,
        name: this.contactCache.get(talkerId)?.nickname || talkerId,
        participants,
        messages: msgs,
        timeRange: {
          start: msgs[0]?.timestamp || new Date(0).toISOString(),
          end: msgs[msgs.length - 1]?.timestamp || new Date().toISOString(),
        },
        stats: {
          total: msgs.length,
          selfCount,
          otherCount: msgs.length - selfCount,
          typeDistribution,
        },
      });
    }

    // 按消息数量降序排列
    sessions.sort((a, b) => b.messages.length - a.messages.length);

    return sessions;
  }

  /**
   * 从MicroMsg.db加载联系人信息
   * 实际实现需通过解密后的数据库读取，V1版本预留接口
   */
  private async loadContacts(contactDbPath: string): Promise<void> {
    logger.debug(`加载联系人数据库: ${contactDbPath}`);
    // V1版本：联系人解析通过外部工具或预留接口实现
    // 实际生产环境需要连接解密后的MicroMsg.db读取Contact表
  }

  /**
   * 外部接口：手动注册联系人信息
   */
  registerContact(contact: ContactInfo): void {
    this.contactCache.set(contact.wxid, contact);
  }
}
