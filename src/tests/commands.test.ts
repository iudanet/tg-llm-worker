import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StoredChatMessage, StreamCallbacks } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate } from '../telegram/types';
import type { BatchBuffer } from '../batch/buffer';
import type { ImageStore } from '../vision/store';
import { parseWhiteList } from '../config';
import { BOT_COMMANDS, handleUpdate } from '../handler';
import { conversationKey } from '../storage/history';

const USER_ID = 42;

function config(): Config {
    return {
        botToken: 't', webhookSecret: null, apiKey: 'k',
        apiBase: 'https://example.invalid/v1', model: 'm', systemPrompt: null,
        whiteList: parseWhiteList(String(USER_ID)), historyMaxMessages: 20,
        historyTtlSeconds: 60, streamIntervalMs: 1000,
        documentThreshold: 4096, useRichMessages: true,
        visionEnabled: true, visionContextImages: 2,
        imageTtlSeconds: 3600, imageMaxBytes: 1024 * 1024,
        // Окно выключено: тесты проверяют поведение, а не ожидание.
        batchWindowMs: 0, batchMaxWaitMs: 8000,
        transcribeEnabled: true, transcribeModel: 'stt', audioMaxBytes: 20 * 1024 * 1024,
    };
}

/**
 * Мок истории: запоминает, какие ключи очищали.
 * calls — общий с моком API журнал вызовов, чтобы проверять их порядок.
 */
class FakeHistory implements HistoryStore {
    readonly cleared: string[] = [];
    constructor(private readonly calls: string[] = []) {}

    async load(): Promise<StoredChatMessage[]> {
        return [];
    }

    async save(): Promise<void> {}

    async clear(key: ConversationKey): Promise<void> {
        this.calls.push('history.clear');
        this.cleared.push(conversationKey(key));
    }
}

/**
 * Мок API: собирает отправленный текст и вызовы удаления треда.
 * calls хранит общий порядок действий — им проверяется, что ответ
 * пользователю уходит до удаления треда, а не после.
 */
interface FakeApi {
    api: TelegramApi;
    sent: SendMessageParams[];
    deleted: Array<{ chatId: number; threadId: number }>;
    calls: string[];
}

function fakeApi(options: { deleteOk?: boolean } = {}): FakeApi {
    const sent: SendMessageParams[] = [];
    const deleted: Array<{ chatId: number; threadId: number }> = [];
    const calls: string[] = [];
    const api = {
        async sendMessage(params: SendMessageParams) {
            calls.push('sendMessage');
            sent.push(params);
            return { ok: true };
        },
        async deleteForumTopic(chatId: number, threadId: number) {
            calls.push('deleteForumTopic');
            deleted.push({ chatId, threadId });
            return options.deleteOk === false
                ? { ok: false, error_code: 400, description: 'Bad Request: TOPIC_ID_INVALID' }
                : { ok: true, result: true };
        },
    } as unknown as TelegramApi;
    return { api, sent, deleted, calls };
}

const provider: ChatProvider = {
    name: 'stub',
    async stream(_messages: ChatMessage[], _callbacks: StreamCallbacks): Promise<string> {
        throw new Error('provider must not be called for commands');
    },
};

function commandUpdate(text: string, threadId?: number): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            ...(threadId === undefined ? {} : { message_thread_id: threadId }),
            from: { id: USER_ID, is_bot: false, first_name: 'U' },
            chat: { id: USER_ID, type: 'private' },
            date: 0,
            text,
        },
    };
}

/** Команды картинок не касаются — хранилище должно остаться нетронутым. */
const images = {
    async read(): Promise<string | null> {
        throw new Error('commands must not touch the image store');
    },
    async write(): Promise<void> {
        throw new Error('commands must not touch the image store');
    },
} as unknown as ImageStore;

/** Команды не буферизуются — буфер должен остаться нетронутым. */
const batches = {
    async append(): Promise<never> {
        throw new Error('commands must not be buffered');
    },
    async load(): Promise<never> {
        throw new Error('commands must not be buffered');
    },
    async clear(): Promise<never> {
        throw new Error('commands must not be buffered');
    },
} as unknown as BatchBuffer;

async function run(text: string, threadId?: number, options: { deleteOk?: boolean } = {}) {
    const { api, sent, deleted, calls } = fakeApi(options);
    const history = new FakeHistory(calls);
    await handleUpdate(commandUpdate(text, threadId), {
        api, provider, history, images, batches, config: config(),
    });
    return { history, sent, deleted, calls };
}

describe('BOT_COMMANDS', () => {
    it('publishes /start first — it is what a new user sees', () => {
        expect(BOT_COMMANDS[0]?.command).toBe('start');
    });

    it('publishes every command the handler answers', () => {
        expect(BOT_COMMANDS.map(c => c.command)).toEqual(['start', 'new', 'delete', 'help']);
    });

    it('gives every command a description for the Telegram menu', () => {
        for (const entry of BOT_COMMANDS) {
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });
});

describe('/start', () => {
    it('greets instead of reporting a cleared context', async () => {
        const { sent } = await run('/start');
        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain('Привет');
        expect(sent[0]?.text).not.toContain('Контекст очищен');
    });

    it('still clears the history', async () => {
        const { history } = await run('/start');
        expect(history.cleared).toEqual([`chat:${USER_ID}`]);
    });

    it('clears only the current thread', async () => {
        const { history } = await run('/start', 7);
        expect(history.cleared).toEqual([`chat:${USER_ID}:7`]);
    });

    it('accepts the /start@botname form', async () => {
        const { sent } = await run('/start@mybot');
        expect(sent[0]?.text).toContain('Привет');
    });
});

describe('/new', () => {
    it('reports the cleared context rather than greeting', async () => {
        const { sent } = await run('/new');
        expect(sent[0]?.text).toContain('Контекст очищен');
        expect(sent[0]?.text).not.toContain('Привет');
    });

    it('clears the history', async () => {
        const { history } = await run('/new');
        expect(history.cleared).toEqual([`chat:${USER_ID}`]);
    });
});

describe('/delete', () => {
    it('clears the history and deletes the topic', async () => {
        const { history, deleted } = await run('/delete', 7);
        expect(history.cleared).toEqual([`chat:${USER_ID}:7`]);
        expect(deleted).toEqual([{ chatId: USER_ID, threadId: 7 }]);
    });

    it('clears the history before deleting the topic', async () => {
        // Обратный порядок оставил бы историю при исчезнувшем треде.
        const { calls } = await run('/delete', 7);
        expect(calls.indexOf('history.clear')).toBeLessThan(calls.indexOf('deleteForumTopic'));
    });

    it('answers before deleting the topic — a deleted topic takes no messages', async () => {
        const { calls } = await run('/delete', 7);
        expect(calls.indexOf('sendMessage')).toBeLessThan(calls.indexOf('deleteForumTopic'));
    });

    it('keeps the history cleared even when deleting the topic fails', async () => {
        const { history, deleted } = await run('/delete', 7, { deleteOk: false });
        expect(deleted).toHaveLength(1);
        expect(history.cleared).toEqual([`chat:${USER_ID}:7`]);
    });

    it('tells the user to remove the topic by hand when deletion fails', async () => {
        const { sent } = await run('/delete', 7, { deleteOk: false });
        expect(sent.at(-1)?.text).toContain('вручную');
    });

    it('outside a topic behaves like /new and deletes nothing', async () => {
        const { history, deleted, sent } = await run('/delete');
        expect(history.cleared).toEqual([`chat:${USER_ID}`]);
        expect(deleted).toEqual([]);
        expect(sent).toHaveLength(1);
    });

    it('accepts the /delete@botname form', async () => {
        const { deleted } = await run('/delete@mybot', 7);
        expect(deleted).toEqual([{ chatId: USER_ID, threadId: 7 }]);
    });
});

describe('/help', () => {
    it('lists /start among the commands', async () => {
        const { sent } = await run('/help');
        expect(sent[0]?.text).toContain('/start');
    });

    it('lists /delete among the commands', async () => {
        const { sent } = await run('/help');
        expect(sent[0]?.text).toContain('/delete');
    });

    it('leaves the history untouched', async () => {
        const { history } = await run('/help');
        expect(history.cleared).toEqual([]);
    });
});

describe('unknown command', () => {
    it('answers with the help text', async () => {
        const { sent, history } = await run('/nope');
        expect(sent[0]?.text).toContain('Неизвестная команда');
        expect(history.cleared).toEqual([]);
    });
});
