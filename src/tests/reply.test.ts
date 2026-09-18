import { describe, expect, it, vi } from 'vitest';
import type { TelegramApi } from '../telegram/api';
import type { TelegramMessage } from '../telegram/types';
import { destinationOf, Replier } from '../telegram/reply';

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
    return {
        message_id: 5,
        chat: { id: 42, type: 'private' },
        date: 0,
        ...overrides,
    } as TelegramMessage;
}

describe('destinationOf', () => {
    it('carries the topic when the message came from one', () => {
        expect(destinationOf(message({ message_thread_id: 77 }))).toEqual({
            chatId: 42,
            threadId: 77,
            replyToMessageId: 5,
        });
    });

    it('leaves the topic undefined outside topics', () => {
        // Подделывать threadId нельзя: вне топика Telegram его не присылает.
        expect(destinationOf(message()).threadId).toBeUndefined();
    });

    it('always remembers which message to answer', () => {
        expect(destinationOf(message()).replyToMessageId).toBe(5);
    });
});

describe('Replier', () => {
    it('routes a notice to the same topic', async () => {
        const sendMessage = vi.fn(async () => ({ ok: true }));
        const replier = new Replier(
            { sendMessage } as unknown as TelegramApi,
            { chatId: 42, threadId: 77 },
        );

        await replier.text('готово');

        expect(sendMessage).toHaveBeenCalledWith({
            chat_id: 42,
            message_thread_id: 77,
            text: 'готово',
        });
    });

    it('does not throw when Telegram rejects a notice', async () => {
        // Служебное сообщение не должно ронять обработку апдейта.
        const sendMessage = vi.fn(async () => ({ ok: false, description: 'blocked' }));
        const replier = new Replier(
            { sendMessage } as unknown as TelegramApi,
            { chatId: 42 },
        );

        await expect(replier.text('готово')).resolves.toBeUndefined();
    });
});
