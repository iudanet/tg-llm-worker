import type { StoredChatMessage } from '../llm/provider';

/**
 * HistoryStore persists per-chat conversation context in Workers KV.
 */
/**
 * ConversationKey identifies one conversation thread.
 *
 * Топики в приватных чатах (Bot API 9.3+) существуют ровно для того, чтобы
 * разговоры не смешивались, поэтому история хранится отдельно для каждого
 * треда, а не одна на весь чат.
 */
export interface ConversationKey {
    chatId: number;
    threadId?: number;
}

export interface HistoryStore {
    load: (key: ConversationKey) => Promise<StoredChatMessage[]>;
    save: (key: ConversationKey, messages: StoredChatMessage[]) => Promise<void>;
    clear: (key: ConversationKey) => Promise<void>;
}

/**
 * conversationKey builds the KV key for a chat or one of its topics.
 */
export function conversationKey(key: ConversationKey): string {
    return key.threadId === undefined
        ? `chat:${key.chatId}`
        : `chat:${key.chatId}:${key.threadId}`;
}

interface StoredHistory {
    messages: StoredChatMessage[];
    updated_at: number;
}

export class KVHistoryStore implements HistoryStore {
    private readonly kv: KVNamespace;
    private readonly maxMessages: number;
    private readonly ttlSeconds: number;

    constructor(kv: KVNamespace, maxMessages: number, ttlSeconds: number) {
        this.kv = kv;
        this.maxMessages = maxMessages;
        this.ttlSeconds = ttlSeconds;
    }

    async load(key: ConversationKey): Promise<StoredChatMessage[]> {
        const raw = await this.kv.get(conversationKey(key), 'json') as StoredHistory | null;
        if (!raw || !Array.isArray(raw.messages)) {
            return [];
        }
        return raw.messages;
    }

    async save(key: ConversationKey, messages: StoredChatMessage[]): Promise<void> {
        const trimmed = trimHistory(messages, this.maxMessages);
        const payload: StoredHistory = { messages: trimmed, updated_at: Date.now() };
        await this.kv.put(conversationKey(key), JSON.stringify(payload), {
            expirationTtl: this.ttlSeconds,
        });
    }

    async clear(key: ConversationKey): Promise<void> {
        await this.kv.delete(conversationKey(key));
    }
}

/**
 * trimHistory keeps the most recent messages within the configured budget.
 * Обрезаем с начала так, чтобы первым остался user-запрос: висящий
 * assistant-ответ без своего вопроса только путает модель.
 */
export function trimHistory(messages: StoredChatMessage[], maxMessages: number): StoredChatMessage[] {
    if (maxMessages <= 0 || messages.length <= maxMessages) {
        return messages;
    }
    const tail = messages.slice(messages.length - maxMessages);
    const firstUser = tail.findIndex(message => message.role === 'user');
    return firstUser <= 0 ? tail : tail.slice(firstUser);
}
