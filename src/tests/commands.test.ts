import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { ChatMessage, ChatProvider, StreamCallbacks } from '../llm/provider';
import type { ConversationKey, HistoryStore } from '../storage/history';
import type { TelegramApi } from '../telegram/api';
import type { SendMessageParams, TelegramUpdate } from '../telegram/types';
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
    };
}

/** Мок истории: запоминает, какие ключи очищали. */
class FakeHistory implements HistoryStore {
    readonly cleared: string[] = [];

    async load(): Promise<ChatMessage[]> {
        return [];
    }

    async save(): Promise<void> {}

    async clear(key: ConversationKey): Promise<void> {
        this.cleared.push(conversationKey(key));
    }
}

/** Мок API: собирает отправленный текст, остальные методы не нужны командам. */
function fakeApi(): { api: TelegramApi; sent: SendMessageParams[] } {
    const sent: SendMessageParams[] = [];
    const api = {
        async sendMessage(params: SendMessageParams) {
            sent.push(params);
            return { ok: true };
        },
    } as unknown as TelegramApi;
    return { api, sent };
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

async function run(text: string, threadId?: number) {
    const history = new FakeHistory();
    const { api, sent } = fakeApi();
    await handleUpdate(commandUpdate(text, threadId), { api, provider, history, config: config() });
    return { history, sent };
}

describe('BOT_COMMANDS', () => {
    it('publishes /start first — it is what a new user sees', () => {
        expect(BOT_COMMANDS[0]?.command).toBe('start');
    });

    it('publishes every command the handler answers', () => {
        expect(BOT_COMMANDS.map(c => c.command)).toEqual(['start', 'new', 'help']);
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

describe('/help', () => {
    it('lists /start among the commands', async () => {
        const { sent } = await run('/help');
        expect(sent[0]?.text).toContain('/start');
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
