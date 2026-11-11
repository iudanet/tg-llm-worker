import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatProvider, StoredChatMessage } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate } from '../telegram/types';
import type { BatchScope, PendingBatch, PendingMessage } from '../batch/buffer';
import { parseWhiteList } from '../config';
import { handleUpdate } from '../handler';
import { appendPending, pendingKey } from '../batch/buffer';
import { conversationKey } from '../storage/history';

const USER_ID = 42;

function config(overrides: Partial<Config> = {}): Config {
    return {
        botToken: 't', webhookSecret: 's', apiKey: 'k',
        apiBase: 'https://example.invalid/v1', model: 'm', systemPrompt: null,
        reasoningEffort: null, generationTimeoutMs: 18000,
        whiteList: parseWhiteList(String(USER_ID)), historyMaxMessages: 20,
        historyTtlSeconds: 60, streamIntervalMs: 1000,
        documentThreshold: 4096, useRichMessages: false,
        visionEnabled: false, visionContextImages: 2,
        imageTtlSeconds: 3600, imageMaxBytes: 1024 * 1024,
        batchWindowMs: 0, batchMaxWaitMs: 8000,
        transcribeEnabled: false, transcribeModel: 'stt',
        audioMaxBytes: 20 * 1024 * 1024,
        ...overrides,
    };
}

class FakeHistory implements HistoryStore {
    cleared: string[] = [];
    async load(): Promise<StoredChatMessage[]> {
        return [];
    }
    async save(): Promise<void> {}
    async clear(key: ConversationKey): Promise<void> {
        this.cleared.push(conversationKey(key));
    }
}

class FakeBatches {
    readonly store = new Map<string, PendingBatch>();
    async load(scope: BatchScope): Promise<PendingBatch> {
        return this.store.get(pendingKey(scope)) ?? { messages: [] };
    }
    async append(scope: BatchScope, message: PendingMessage, now: number = Date.now()): Promise<PendingBatch> {
        const current = await this.load(scope);
        const batch = { messages: appendPending(current.messages, message), updatedAt: now };
        this.store.set(pendingKey(scope), batch);
        return batch;
    }
    async clear(scope: BatchScope): Promise<void> {
        this.store.delete(pendingKey(scope));
    }
}

/**
 * Провайдер, который не должен вызываться: команда обязана перехватываться
 * до обращения к модели. На скриншоте пользователя на /delete отвечала
 * именно модель — значит команда до обработчика не доходила.
 */
function forbiddenProvider(): { provider: ChatProvider; calls: { n: number } } {
    const calls = { n: 0 };
    return {
        calls,
        provider: {
            name: 'stub',
            async stream() {
                calls.n += 1;
                return 'ответ модели (команда утекла в LLM)';
            },
        },
    };
}

/** Команда в топике — ровно как в чате, где воспроизводится проблема. */
function commandUpdate(text: string, threadId?: number): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
            // Telegram размечает команды; раньше это поле игнорировалось.
            entities: [{ type: 'bot_command', offset: 0, length: text.length }],
        },
    };
}

async function run(text: string, threadId?: number) {
    const sent: SendMessageParams[] = [];
    const deleted: Array<{ chatId: number; threadId: number }> = [];
    const api = {
        async sendMessage(params: SendMessageParams) {
            sent.push(params);
            return { ok: true };
        },
        async sendMessageDraft() {
            return { ok: true, result: true };
        },
        async deleteForumTopic(chatId: number, thread: number) {
            deleted.push({ chatId, threadId: thread });
            return { ok: true, result: true };
        },
        async editForumTopic() {
            return { ok: true, result: true };
        },
    } as unknown as TelegramApi;

    const { provider, calls } = forbiddenProvider();
    const history = new FakeHistory();
    await handleUpdate(commandUpdate(text, threadId), {
        api,
        provider,
        history,
        images: {} as never,
        batches: new FakeBatches() as never,
        config: config(),
    } as never);
    return { sent, deleted, history, modelCalls: calls.n };
}

describe('identifier validation', () => {
    /** Собирает апдейт с подменённым полем, минуя типы TypeScript. */
    async function runRaw(patch: Record<string, unknown>) {
        const sent: SendMessageParams[] = [];
        const api = {
            async sendMessage(params: SendMessageParams) {
                sent.push(params);
                return { ok: true };
            },
            async sendMessageDraft() {
                return { ok: true, result: true };
            },
            async editForumTopic() {
                return { ok: true, result: true };
            },
        } as unknown as TelegramApi;

        const { provider, calls } = forbiddenProvider();
        const base = commandUpdate('привет');
        const update = {
            ...base,
            message: { ...base.message, ...patch },
        } as unknown as TelegramUpdate;

        await handleUpdate(update, {
            api,
            provider,
            history: new FakeHistory(),
            images: {} as never,
            batches: new FakeBatches() as never,
            config: config(),
        } as never);
        return { sent, modelCalls: calls.n };
    }

    it('drops an update whose chat id is a string', async () => {
        // "42:77" в ключе дало бы chat:42:77 — топик 77 чужого разговора.
        const { sent, modelCalls } = await runRaw({ chat: { id: '42:77', type: 'private' } });

        expect(modelCalls).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it('drops an update whose thread id is a string', async () => {
        const { sent, modelCalls } = await runRaw({ message_thread_id: '77' });

        expect(modelCalls).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it('drops an update whose ids are not finite numbers', async () => {
        const { modelCalls } = await runRaw({ message_id: Number.NaN });

        expect(modelCalls).toBe(0);
    });

    it('accepts an ordinary update', async () => {
        const { modelCalls } = await runRaw({});

        expect(modelCalls).toBe(1);
    });
});

describe('command dispatch', () => {
    it('never lets /delete reach the model', async () => {
        const { modelCalls } = await run('/delete', 77);
        expect(modelCalls).toBe(0);
    });

    it('never lets /info reach the model', async () => {
        const { modelCalls, sent } = await run('/info', 77);
        expect(modelCalls).toBe(0);
        expect(sent[0]?.text).toContain('tg-llm-worker');
    });

    it('handles /delete inside a topic', async () => {
        const { deleted, history } = await run('/delete', 77);
        expect(history.cleared).toEqual([`chat:${USER_ID}:77`]);
        expect(deleted).toEqual([{ chatId: USER_ID, threadId: 77 }]);
    });

    it('answers an unknown command instead of asking the model', async () => {
        const { modelCalls, sent } = await run('/whatever', 77);
        expect(modelCalls).toBe(0);
        expect(sent[0]?.text).toContain('Неизвестная команда');
    });

    it('accepts the /cmd@botname form', async () => {
        const { modelCalls, sent } = await run('/info@iudanet_bot', 77);
        expect(modelCalls).toBe(0);
        expect(sent[0]?.text).toContain('tg-llm-worker');
    });
});
