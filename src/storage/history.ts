import type { ChatMessage } from '../llm/provider';

/**
 * HistoryStore persists per-chat conversation context in Workers KV.
 */
export interface HistoryStore {
    load: (chatId: number) => Promise<ChatMessage[]>;
    save: (chatId: number, messages: ChatMessage[]) => Promise<void>;
    clear: (chatId: number) => Promise<void>;
}

interface StoredHistory {
    messages: ChatMessage[];
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

    private key(chatId: number): string {
        return `chat:${chatId}`;
    }

    async load(chatId: number): Promise<ChatMessage[]> {
        const raw = await this.kv.get(this.key(chatId), 'json') as StoredHistory | null;
        if (!raw || !Array.isArray(raw.messages)) {
            return [];
        }
        return raw.messages;
    }

    async save(chatId: number, messages: ChatMessage[]): Promise<void> {
        const trimmed = trimHistory(messages, this.maxMessages);
        const payload: StoredHistory = { messages: trimmed, updated_at: Date.now() };
        await this.kv.put(this.key(chatId), JSON.stringify(payload), {
            expirationTtl: this.ttlSeconds,
        });
    }

    async clear(chatId: number): Promise<void> {
        await this.kv.delete(this.key(chatId));
    }
}

/**
 * trimHistory keeps the most recent messages within the configured budget.
 * Обрезаем с начала так, чтобы первым остался user-запрос: висящий
 * assistant-ответ без своего вопроса только путает модель.
 */
export function trimHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
    if (maxMessages <= 0 || messages.length <= maxMessages) {
        return messages;
    }
    const tail = messages.slice(messages.length - maxMessages);
    const firstUser = tail.findIndex(message => message.role === 'user');
    return firstUser <= 0 ? tail : tail.slice(firstUser);
}
