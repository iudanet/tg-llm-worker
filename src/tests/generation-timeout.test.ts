import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StoredChatMessage, StreamCallbacks } from '../llm/provider';
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
        reasoningEffort: 'low', generationTimeoutMs: 30,
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
    saved = new Map<string, StoredChatMessage[]>();

    async load(): Promise<StoredChatMessage[]> {
        return [];
    }

    async save(key: ConversationKey, messages: StoredChatMessage[]): Promise<void> {
        this.saved.set(conversationKey(key), messages);
    }

    async clear(): Promise<void> {}
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

function fakeApi() {
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
    return { api, sent };
}

/**
 * hangingProvider emits a few deltas and then never finishes, like a model
 * still generating when the worker's waitUntil budget runs out.
 */
function hangingProvider(prefix: string): ChatProvider {
    return {
        name: 'stub',
        async stream(_messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal): Promise<string> {
            await callbacks.onDelta(prefix);
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        },
    };
}

function textUpdate(text: string): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
        },
    };
}

async function run(provider: ChatProvider, overrides: Partial<Config> = {}) {
    const { api, sent } = fakeApi();
    const history = new FakeHistory();
    await handleUpdate(textUpdate('вопрос'), {
        api,
        provider,
        history,
        images: {} as never,
        batches: new FakeBatches() as never,
        config: config(overrides),
    } as never);
    return { sent, history };
}

describe('generation timeout', () => {
    it('delivers what the model managed to produce instead of losing it', async () => {
        // Регрессия: воркер умирал по waitUntil, черновик протухал, и в чате
        // не оставалось ничего — «написал и удалил».
        const { sent } = await run(hangingProvider('частичный ответ'));

        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain('частичный ответ');
        expect(sent[0]?.text).toContain('обрезан по таймауту');
    });

    it('stores the partial answer without the truncation notice', async () => {
        // Пометка адресована человеку; модели в следующем запросе она мешает.
        const { history } = await run(hangingProvider('частичный ответ'));

        const stored = [...history.saved.values()][0];
        expect(stored?.at(-1)?.content).toBe('частичный ответ');
    });

    it('explains the failure when nothing was generated at all', async () => {
        const silent: ChatProvider = {
            name: 'stub',
            async stream(_messages, _callbacks, signal?: AbortSignal) {
                return new Promise<string>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            },
        };

        const { sent } = await run(silent);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain('не успела ответить');
    });

    it('leaves a fast answer untouched', async () => {
        const quick: ChatProvider = {
            name: 'stub',
            async stream() {
                return 'быстрый ответ';
            },
        };

        const { sent, history } = await run(quick);

        expect(sent[0]?.text).toBe('быстрый ответ');
        const stored = [...history.saved.values()][0];
        expect(stored?.at(-1)?.content).toBe('быстрый ответ');
    });
});
