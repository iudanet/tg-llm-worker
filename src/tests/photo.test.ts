import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StoredChatMessage, StreamCallbacks } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate } from '../telegram/types';
import type { BatchScope, PendingBatch, PendingMessage } from '../batch/buffer';
import type { ImageStore } from '../vision/store';
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
        // По умолчанию окно выключено: батчинг проверяется отдельными тестами.
        batchWindowMs: 0, batchMaxWaitMs: 8000,
        transcribeEnabled: true, transcribeModel: 'stt', audioMaxBytes: 20 * 1024 * 1024,
        ...overrides,
    };
}

/** Мок истории в памяти. */
class FakeHistory implements HistoryStore {
    saved = new Map<string, StoredChatMessage[]>();
    constructor(private readonly preset: StoredChatMessage[] = []) {}

    async load(): Promise<StoredChatMessage[]> {
        return this.preset;
    }

    async save(key: ConversationKey, messages: StoredChatMessage[]): Promise<void> {
        this.saved.set(conversationKey(key), messages);
    }

    async clear(): Promise<void> {}
}

/** Мок хранилища картинок в памяти. */
class FakeImages {
    readonly data = new Map<string, string>();

    async read(key: string): Promise<string | null> {
        return this.data.get(key) ?? null;
    }

    async write(key: string, base64: string): Promise<void> {
        this.data.set(key, base64);
    }
}

interface ApiOptions {
    getFileOk?: boolean;
    downloadBytes?: number | null;
    renameOk?: boolean;
}

function fakeApi(options: ApiOptions = {}) {
    const sent: SendMessageParams[] = [];
    const renamed: string[] = [];
    const api = {
        async sendMessage(params: SendMessageParams) {
            sent.push(params);
            return { ok: true };
        },
        async editForumTopic(_chatId: number, _threadId: number, name: string) {
            renamed.push(name);
            return options.renameOk === false
                ? { ok: false, error_code: 400, description: 'Bad Request' }
                : { ok: true, result: true };
        },
        async sendMessageDraft() {
            return { ok: true, result: true };
        },
        async getFile(fileId: string) {
            return options.getFileOk === false
                ? { ok: false, error_code: 400, description: 'file is too big' }
                : { ok: true, result: { file_id: fileId, file_unique_id: 'u', file_path: 'photos/x.jpg' } };
        },
        async downloadFile(): Promise<ArrayBuffer | null> {
            if (options.downloadBytes === null) {
                return null;
            }
            return new ArrayBuffer(options.downloadBytes ?? 16);
        },
    } as unknown as TelegramApi;
    return { api, sent, renamed };
}

/** Буфер пачек в памяти — та же логика, что в KV-реализации. */
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
        const batch = {
            messages: appendPending(current.messages, message),
            updatedAt: now,
        };
        this.store.set(pendingKey(scope), batch);
        return batch;
    }

    async clear(scope: BatchScope): Promise<void> {
        this.store.delete(pendingKey(scope));
    }
}

/** Провайдер, запоминающий то, что реально ушло в модель. */
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

function photoUpdate(caption?: string, fileSize?: number): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            message_thread_id: THREAD_ID,
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            ...(caption === undefined ? {} : { caption }),
            photo: [
                { file_id: 'small', file_unique_id: 'us', width: 90, height: 90, file_size: 2_000 },
                {
                    file_id: 'big',
                    file_unique_id: 'ub',
                    width: 1280,
                    height: 1280,
                    ...(fileSize === undefined ? {} : { file_size: fileSize }),
                },
            ],
        },
    };
}

type BatchBufferLike = import('../batch/buffer').BatchBuffer;

async function run(update: TelegramUpdate, options: {
    api?: ApiOptions;
    cfg?: Partial<Config>;
    preset?: StoredChatMessage[];
    batches?: FakeBatches;
    sleep?: (ms: number) => Promise<void>;
} = {}) {
    const { api, sent, renamed } = fakeApi(options.api);
    const { provider, seen } = fakeProvider();
    const history = new FakeHistory(options.preset ?? []);
    const images = new FakeImages();
    const batches = options.batches ?? new FakeBatches();
    await handleUpdate(update, {
        api,
        provider,
        history,
        images: images as unknown as ImageStore,
        batches: batches as unknown as BatchBufferLike,
        config: config(options.cfg),
        // Окно не выжидаем по-настоящему: тесты не должны спать.
        sleep: options.sleep ?? (async () => {}),
    });
    return { sent, seen, history, images, renamed, batches };
}

/**
 * threadId передаётся явно: значение по умолчанию в JS срабатывает и на
 * явный undefined, из-за чего «вне топика» не получилось бы выразить.
 */
function textUpdate(text: string, threadId: number | null = THREAD_ID): TelegramUpdate {
    return {
        update_id: 3,
        message: {
            message_id: 3,
            ...(threadId === null ? {} : { message_thread_id: threadId }),
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
        },
    };
}

function textUpdateWithId(text: string, messageId: number): TelegramUpdate {
    return {
        update_id: messageId,
        message: {
            message_id: messageId,
            message_thread_id: THREAD_ID,
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
        },
    };
}

describe('topic naming', () => {
    it('names a fresh topic after the first message', async () => {
        // Клиент называет новый топик «Новый чат» — имя ставит бот.
        const { renamed } = await run(textUpdate('Как работает KV в Workers?'));
        expect(renamed).toEqual(['Как работает KV в Workers?']);
    });

    it('does not rename once the conversation has history', async () => {
        const { renamed } = await run(textUpdate('второй вопрос'), {
            preset: [{ role: 'user', content: 'первый вопрос' }],
        });
        expect(renamed).toEqual([]);
    });

    it('names the topic from a photo caption too', async () => {
        const { renamed } = await run(photoUpdate('что на схеме?'));
        expect(renamed).toEqual(['что на схеме?']);
    });

    it('skips renaming outside topics', async () => {
        const { renamed } = await run(textUpdate('привет', null));
        expect(renamed).toEqual([]);
    });

    it('still answers when renaming fails', async () => {
        // Имя топика косметика: отказ метода не должен ломать ответ.
        const { seen, renamed } = await run(textUpdate('вопрос'), {
            api: { renameOk: false },
        });
        expect(renamed).toEqual(['вопрос']);
        expect(seen).toHaveLength(1);
    });
});

describe('bursts of messages', () => {
    /**
     * Пересылка и комментарий приходят двумя апдейтами. Оба обрабатываются
     * общим буфером, поэтому здесь они прогоняются через один FakeBatches —
     * так же, как это происходит в одном изоляте воркера.
     */
    async function burst(texts: string[], startId = 10) {
        const batches = new FakeBatches();
        const { api, sent, renamed } = fakeApi();
        const { provider, seen } = fakeProvider();
        const history = new FakeHistory([]);
        const images = new FakeImages();

        // Все апдейты кладутся в буфер до того, как истечёт окно первого:
        // именно так выглядит быстрая серия сообщений.
        const deps = {
            api,
            provider,
            history,
            images: images as unknown as ImageStore,
            batches: batches as unknown as BatchBufferLike,
            config: config({ batchWindowMs: 1500 }),
            sleep: async () => {},
        };

        for (const [index, text] of texts.entries()) {
            await batches.append(
                { chatId: USER_ID, threadId: THREAD_ID },
                { id: startId + index, content: text },
            );
        }
        for (const [index, text] of texts.entries()) {
            await handleUpdate(textUpdateWithId(text, startId + index), deps);
        }
        return { sent, seen, renamed, history, batches };
    }

    it('answers once for a forward and its comment', async () => {
        const { seen } = await burst(['пересланный текст', 'что думаешь?']);
        expect(seen).toHaveLength(1);
    });

    it('gives the model both messages as one question', async () => {
        const { seen } = await burst(['пересланный текст', 'что думаешь?']);
        expect(seen[0]?.at(-1)?.content).toBe('пересланный текст\n\nчто думаешь?');
    });

    it('saves one merged turn instead of overwriting history', async () => {
        // Раньше две параллельные записи перетирали друг друга.
        const { history } = await burst(['первое', 'второе']);
        const saved = history.saved.get(`chat:${USER_ID}:${THREAD_ID}`);
        expect(saved).toHaveLength(2);
        expect(saved?.[0]?.content).toBe('первое\n\nвторое');
        expect(saved?.[1]?.role).toBe('assistant');
    });

    it('clears the buffer so the next question starts clean', async () => {
        const { batches } = await burst(['первое', 'второе']);
        const left = await batches.load({ chatId: USER_ID, threadId: THREAD_ID });
        expect(left.messages).toEqual([]);
    });

    it('answers a lone message without waiting for a partner', async () => {
        const { seen } = await burst(['один вопрос']);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.at(-1)?.content).toBe('один вопрос');
    });
});

describe('slow bursts', () => {
    /**
     * Серия, растянутая дольше окна: сообщения приходят не одновременно.
     * Фиксированное окно здесь развалилось бы — окно первого сообщения
     * истекало бы раньше, чем доставлен последний, и ответов было бы несколько.
     *
     * Каждый апдейт обрабатывается своим handleUpdate, как в воркере; часы
     * и сон подменены, поэтому тест не спит по-настоящему.
     */
    async function slowBurst(count: number, options: { maxWaitMs?: number } = {}) {
        const WINDOW = 1500;
        const START = 100_000;

        const batches = new FakeBatches();
        const { api, sent } = fakeApi();
        const { provider, seen } = fakeProvider();
        const history = new FakeHistory([]);
        const images = new FakeImages();
        const scope = { chatId: USER_ID, threadId: THREAD_ID };

        let clock = START;
        const deps = {
            api,
            provider,
            history,
            images: images as unknown as ImageStore,
            batches: batches as unknown as BatchBufferLike,
            config: config({
                batchWindowMs: WINDOW,
                batchMaxWaitMs: options.maxWaitMs ?? 8000,
            }),
            // Сон только двигает часы: доставку эмулирует цикл ниже.
            sleep: async (ms: number) => {
                clock += ms;
            },
            now: () => clock,
        };

        // Сообщения приходят по одному с паузой меньше окна, поэтому окно
        // каждый раз продлевается.
        const running: Array<Promise<void>> = [];
        for (let index = 0; index < count; index += 1) {
            const id = 10 + index;
            const text = `сообщение ${index + 1}`;
            clock += Math.floor(WINDOW / 2);
            await batches.append(scope, { id, content: text }, clock);
            running.push(handleUpdate(textUpdateWithId(text, id), deps));
            // Даём обработчику дойти до своего первого сна.
            await Promise.resolve();
        }
        await Promise.all(running);

        return { sent, seen, history, batches, elapsed: () => clock - START };
    }

    it('answers once for a burst stretched beyond the window', async () => {
        const { seen } = await slowBurst(5);
        expect(seen).toHaveLength(1);
    });

    it('merges every message of a slow burst into one question', async () => {
        const { seen } = await slowBurst(5);
        const content = seen[0]?.at(-1)?.content as string;
        expect(content).toContain('сообщение 1');
        expect(content).toContain('сообщение 5');
    });

    it('caps the wait instead of following an endless stream', async () => {
        const { seen } = await slowBurst(40, { maxWaitMs: 3000 });
        // Хотя бы один ответ должен состояться, несмотря на поток.
        expect(seen.length).toBeGreaterThanOrEqual(1);
    });
});

describe('handleUpdate with a photo', () => {
    it('sends the image to the model as a data URL', async () => {
        const { seen } = await run(photoUpdate('что тут?'));
        const parts = seen[0]?.at(-1)?.content as Array<{ type: string; url?: string }>;
        expect(parts.map(p => p.type)).toEqual(['text', 'image']);
        expect(parts[1]?.url).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('uses the caption as the question', async () => {
        const { seen } = await run(photoUpdate('что тут?'));
        const parts = seen[0]?.at(-1)?.content as Array<{ type: string; text?: string }>;
        expect(parts[0]?.text).toBe('что тут?');
    });

    it('asks its own question when the photo has no caption', async () => {
        const { seen } = await run(photoUpdate());
        const parts = seen[0]?.at(-1)?.content as Array<{ type: string; text?: string }>;
        expect(parts[0]?.text).toContain('изображении');
    });

    it('stores a reference in history, never the image bytes', async () => {
        const { history } = await run(photoUpdate('что тут?'));
        const saved = history.saved.get(`chat:${USER_ID}:${THREAD_ID}`);
        const parts = saved?.[0]?.content as Array<{ type: string; key?: string }>;
        expect(parts[1]?.type).toBe('image_ref');
        // В KV истории не должно быть base64 — только ссылка на отдельный ключ.
        expect(JSON.stringify(saved)).not.toContain('base64');
    });

    it('keeps the image in its own KV key', async () => {
        const { images } = await run(photoUpdate('что тут?'));
        expect([...images.data.keys()]).toEqual([`img:${USER_ID}:${THREAD_ID}:ub`]);
    });

    it('picks the largest variant that fits the limit', async () => {
        // Крупный вариант превышает лимит — должен уйти маленький.
        const { images } = await run(photoUpdate('что тут?', 5_000_000));
        expect([...images.data.keys()]).toEqual([`img:${USER_ID}:${THREAD_ID}:us`]);
    });

    it('refuses when every variant is over the limit', async () => {
        const { sent, seen } = await run(photoUpdate('что тут?', 5_000_000), {
            cfg: { imageMaxBytes: 1_000 },
        });
        expect(sent[0]?.text).toContain('слишком большая');
        expect(seen).toHaveLength(0);
    });

    it('refuses when the downloaded image exceeds the limit', async () => {
        // file_size необязателен, поэтому реальный размер известен только после скачивания.
        const { sent, seen } = await run(photoUpdate('что тут?'), {
            api: { downloadBytes: 2_000_000 },
        });
        expect(sent[0]?.text).toContain('Не удалось загрузить');
        expect(seen).toHaveLength(0);
    });

    it('reports a failure instead of staying silent when getFile fails', async () => {
        const { sent, seen } = await run(photoUpdate('что тут?'), {
            api: { getFileOk: false },
        });
        expect(sent[0]?.text).toContain('Не удалось загрузить');
        expect(seen).toHaveLength(0);
    });

    it('says so when vision is switched off', async () => {
        const { sent, seen } = await run(photoUpdate('что тут?'), {
            cfg: { visionEnabled: false },
        });
        expect(sent[0]?.text).toContain('отключена');
        expect(seen).toHaveLength(0);
    });

    it('answers follow-up questions about an image already in history', async () => {
        // Картинка из прошлого сообщения должна снова уехать в модель:
        // без этого «а что в углу?» отвечать не по чему.
        const preset: StoredChatMessage[] = [{
            role: 'user',
            content: [
                { type: 'text', text: 'что тут?' },
                { type: 'image_ref', key: 'img:42:7:old', fileId: 'big', mime: 'image/jpeg' },
            ],
        }];
        const { seen } = await run({
            update_id: 2,
            message: {
                message_id: 2,
                message_thread_id: THREAD_ID,
                from: { id: USER_ID, is_bot: false, first_name: 'U' },
                chat: { id: USER_ID, type: 'private' },
                date: 0,
                text: 'а что в правом углу?',
            },
        }, { preset });

        const first = seen[0]?.[0]?.content as Array<{ type: string }>;
        // Картинка отсутствует в KV, но перекачивается по file_id.
        expect(first.map(p => p.type)).toEqual(['text', 'image']);
    });
});
