import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StoredChatMessage, StreamCallbacks } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate } from '../telegram/types';
import type { ImageStore } from '../vision/store';
import { parseWhiteList } from '../config';
import { handleUpdate } from '../handler';
import { conversationKey } from '../storage/history';

const USER_ID = 42;
const THREAD_ID = 7;

function config(overrides: Partial<Config> = {}): Config {
    return {
        botToken: 't', webhookSecret: null, apiKey: 'k',
        apiBase: 'https://example.invalid/v1', model: 'm', systemPrompt: null,
        whiteList: parseWhiteList(String(USER_ID)), historyMaxMessages: 20,
        historyTtlSeconds: 60, streamIntervalMs: 1000,
        documentThreshold: 4096, useRichMessages: false,
        visionEnabled: true, visionContextImages: 2,
        imageTtlSeconds: 3600, imageMaxBytes: 1024 * 1024,
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

async function run(update: TelegramUpdate, options: {
    api?: ApiOptions;
    cfg?: Partial<Config>;
    preset?: StoredChatMessage[];
} = {}) {
    const { api, sent, renamed } = fakeApi(options.api);
    const { provider, seen } = fakeProvider();
    const history = new FakeHistory(options.preset ?? []);
    const images = new FakeImages();
    await handleUpdate(update, {
        api,
        provider,
        history,
        images: images as unknown as ImageStore,
        config: config(options.cfg),
    });
    return { sent, seen, history, images, renamed };
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
