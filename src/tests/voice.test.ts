import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StoredChatMessage, StreamCallbacks } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate, TelegramVoice } from '../telegram/types';
import type { BatchScope, PendingBatch, PendingMessage } from '../batch/buffer';
import type { ImageStore } from '../vision/store';
import type { BatchBuffer } from '../batch/buffer';
import { parseWhiteList } from '../config';
import { handleUpdate } from '../handler';
import { appendPending, pendingKey } from '../batch/buffer';
import { conversationKey } from '../storage/history';

const USER_ID = 42;
const THREAD_ID = 7;

function config(overrides: Partial<Config> = {}): Config {
    return {
        botToken: 't', webhookSecret: 's', apiKey: 'k',
        apiBase: 'https://example.invalid/v1', model: 'm', systemPrompt: null,
        reasoningEffort: null, generationTimeoutMs: 18000,
        whiteList: parseWhiteList(String(USER_ID)), historyMaxMessages: 20,
        historyTtlSeconds: 60, streamIntervalMs: 1000,
        documentThreshold: 4096, useRichMessages: false,
        visionEnabled: true, visionContextImages: 2,
        imageTtlSeconds: 3600, imageMaxBytes: 1024 * 1024,
        batchWindowMs: 0, batchMaxWaitMs: 8000,
        transcribeEnabled: true, transcribeModel: 'stt',
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

    async append(
        scope: BatchScope,
        message: PendingMessage,
        now: number = Date.now(),
    ): Promise<PendingBatch> {
        const current = await this.load(scope);
        const batch = { messages: appendPending(current.messages, message), updatedAt: now };
        this.store.set(pendingKey(scope), batch);
        return batch;
    }

    async clear(scope: BatchScope): Promise<void> {
        this.store.delete(pendingKey(scope));
    }
}

interface ApiOptions {
    getFileOk?: boolean;
    downloadOk?: boolean;
}

function fakeApi(options: ApiOptions = {}) {
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
        async getFile(fileId: string) {
            return options.getFileOk === false
                ? { ok: false, error_code: 400, description: 'file is too big' }
                : { ok: true, result: { file_id: fileId, file_unique_id: 'u', file_path: 'voice/file_9.oga' } };
        },
        async downloadFile(): Promise<ArrayBuffer | null> {
            return options.downloadOk === false ? null : new ArrayBuffer(64);
        },
    } as unknown as TelegramApi;
    return { api, sent };
}

function fakeProvider(): { provider: ChatProvider; seen: ChatMessage[][] } {
    const seen: ChatMessage[][] = [];
    const provider: ChatProvider = {
        name: 'stub',
        async stream(messages: ChatMessage[], _callbacks: StreamCallbacks): Promise<string> {
            seen.push(messages);
            return 'ответ модели';
        },
    };
    return { provider, seen };
}

function voiceUpdate(voice: TelegramVoice = { file_id: 'v1' }): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            message_thread_id: THREAD_ID,
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            voice,
        },
    };
}

/** Подменяет fetch: транскрипция ходит по HTTP. */
async function withTranscription<T>(
    responder: () => Response,
    run: () => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => responder()) as typeof fetch;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

async function run(update: TelegramUpdate, options: {
    api?: ApiOptions;
    cfg?: Partial<Config>;
    transcript?: () => Response;
} = {}) {
    const { api, sent } = fakeApi(options.api);
    const { provider, seen } = fakeProvider();
    const history = new FakeHistory();
    const batches = new FakeBatches();

    await withTranscription(
        options.transcript ?? (() => new Response('расскажи про KV', { status: 200 })),
        () => handleUpdate(update, {
            api,
            provider,
            history,
            images: {} as unknown as ImageStore,
            batches: batches as unknown as BatchBuffer,
            config: config(options.cfg),
        }),
    );
    return { sent, seen, history };
}

describe('handleUpdate with a voice note', () => {
    it('shows the transcript before answering', async () => {
        const { sent } = await run(voiceUpdate());
        expect(sent[0]?.text).toContain('расскажи про KV');
    });

    it('answers the question from the recording', async () => {
        const { seen } = await run(voiceUpdate());
        expect(seen).toHaveLength(1);
        expect(seen[0]?.at(-1)?.content).toBe('расскажи про KV');
    });

    it('stores the transcript in history for follow-up questions', async () => {
        const { history } = await run(voiceUpdate());
        const saved = history.saved.get(`chat:${USER_ID}:${THREAD_ID}`);
        expect(saved?.[0]?.content).toBe('расскажи про KV');
        expect(saved?.[1]?.role).toBe('assistant');
    });

    it('handles an audio file the same way as a voice note', async () => {
        const update = voiceUpdate();
        update.message = { ...update.message!, voice: undefined, audio: { file_id: 'a1' } };
        const { seen } = await run(update);
        expect(seen).toHaveLength(1);
    });

    it('explains a format rejection instead of staying silent', async () => {
        const { sent, seen } = await run(voiceUpdate(), {
            transcript: () => new Response('Unsupported file format', { status: 400 }),
        });
        expect(sent[0]?.text).toContain('формат');
        expect(seen).toHaveLength(0);
    });

    it('reports an empty transcript', async () => {
        const { sent, seen } = await run(voiceUpdate(), {
            transcript: () => new Response('   ', { status: 200 }),
        });
        expect(sent[0]?.text).toContain('не разобрал');
        expect(seen).toHaveLength(0);
    });

    it('refuses a recording over the size limit without downloading it', async () => {
        const { sent, seen } = await run(
            voiceUpdate({ file_id: 'v1', file_size: 30 * 1024 * 1024 }),
        );
        expect(sent[0]?.text).toContain('слишком большая');
        expect(seen).toHaveLength(0);
    });

    it('says so when transcription is switched off', async () => {
        const { sent, seen } = await run(voiceUpdate(), {
            cfg: { transcribeEnabled: false },
        });
        expect(sent[0]?.text).toContain('отключено');
        expect(seen).toHaveLength(0);
    });

    it('reports a Telegram download failure', async () => {
        const { sent, seen } = await run(voiceUpdate(), {
            api: { getFileOk: false },
        });
        expect(sent[0]?.text).toContain('Не удалось получить запись');
        expect(seen).toHaveLength(0);
    });

    it('reports a missing API key rather than failing silently', async () => {
        const { sent, seen } = await run(voiceUpdate(), { cfg: { apiKey: '' } });
        expect(sent[0]?.text).toContain('ключ API');
        expect(seen).toHaveLength(0);
    });
});
