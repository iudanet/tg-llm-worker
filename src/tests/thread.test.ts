import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatProvider, StoredChatMessage } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type {
    SendDocumentParams,
    SendMessageDraftParams,
    SendMessageParams,
    TelegramUpdate,
} from '../telegram/types';
import type { BatchScope, PendingBatch, PendingMessage } from '../batch/buffer';
import { parseWhiteList } from '../config';
import { handleUpdate } from '../handler';
import { appendPending, pendingKey } from '../batch/buffer';
import { conversationKey } from '../storage/history';

const USER_ID = 42;
const THREAD_ID = 77;

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

function recordingApi() {
    const sent: SendMessageParams[] = [];
    const drafts: SendMessageDraftParams[] = [];
    const documents: SendDocumentParams[] = [];
    const api = {
        async sendMessage(params: SendMessageParams) {
            sent.push(params);
            return { ok: true };
        },
        async sendMessageDraft(params: SendMessageDraftParams) {
            drafts.push(params);
            return { ok: true, result: true };
        },
        async sendDocument(params: SendDocumentParams) {
            documents.push(params);
            return { ok: true, result: { message_id: 1 } };
        },
        async editForumTopic() {
            return { ok: true, result: true };
        },
    } as unknown as TelegramApi;
    return { api, sent, drafts, documents };
}

function provider(answer: string): ChatProvider {
    return {
        name: 'stub',
        async stream(_messages, callbacks) {
            await callbacks.onDelta(answer);
            return answer;
        },
    };
}

/** Сообщение из топика: Telegram проставляет message_thread_id. */
function update(threadId: number | undefined, text = 'вопрос'): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
        },
    };
}

async function run(threadId: number | undefined, answer = 'ответ', overrides: Partial<Config> = {}) {
    const recorded = recordingApi();
    const history = new FakeHistory();
    await handleUpdate(update(threadId), {
        api: recorded.api,
        provider: provider(answer),
        history,
        images: {} as never,
        batches: new FakeBatches() as never,
        config: config(overrides),
    } as never);
    return { ...recorded, history };
}

describe('topic routing', () => {
    it('answers inside the topic the question came from', async () => {
        const { sent } = await run(THREAD_ID);

        expect(sent).toHaveLength(1);
        expect(sent[0]?.message_thread_id).toBe(THREAD_ID);
    });

    it('streams the draft into the same topic', async () => {
        const { drafts } = await run(THREAD_ID);

        expect(drafts.length).toBeGreaterThan(0);
        for (const draft of drafts) {
            expect(draft.message_thread_id).toBe(THREAD_ID);
        }
    });

    it('keeps the topic when the answer goes out as a document', async () => {
        const { documents } = await run(THREAD_ID, 'x'.repeat(5000));

        expect(documents).toHaveLength(1);
        expect(documents[0]?.message_thread_id).toBe(THREAD_ID);
    });

    it('scopes history per topic so topics stay isolated', async () => {
        const { history } = await run(THREAD_ID);

        expect([...history.saved.keys()]).toEqual([`chat:${USER_ID}:${THREAD_ID}`]);
    });

    it('binds the answer to the question so Telegram places it in the thread', async () => {
        // Одного message_thread_id в личном чате не хватает: ответ оседал
        // в общем потоке, хотя вопрос числился в треде.
        const { sent } = await run(THREAD_ID);

        expect(sent[0]?.reply_parameters?.message_id).toBe(1);
        // Без флага удалённый пользователем вопрос отменил бы весь ответ.
        expect(sent[0]?.reply_parameters?.allow_sending_without_reply).toBe(true);
    });

    it('quotes the question only once in a multi-part answer', async () => {
        const { sent } = await run(THREAD_ID, 'y'.repeat(9000), { documentThreshold: 100_000 });

        expect(sent.length).toBeGreaterThan(1);
        expect(sent[0]?.reply_parameters?.message_id).toBe(1);
        expect(sent[1]?.reply_parameters).toBeUndefined();
    });

    it('binds a document answer to the question too', async () => {
        const { documents } = await run(THREAD_ID, 'z'.repeat(5000));

        expect(documents[0]?.reply_parameters?.message_id).toBe(1);
    });

    it('omits the thread id outside topics', async () => {
        // Вне топика Telegram не присылает message_thread_id, и мы не должны
        // его выдумывать: иначе ответ уйдёт в несуществующий тред.
        const { sent } = await run(undefined);

        expect(sent[0]?.message_thread_id).toBeUndefined();
    });
});
