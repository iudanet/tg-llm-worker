import { describe, expect, it } from 'vitest';
import { TelegramApi } from '../telegram/api';

/**
 * Проверяем не внутренние структуры, а фактическое тело HTTP-запроса:
 * ответ уходил в общий поток, и подозрение было на сериализацию.
 */
async function captureBody(run: (api: TelegramApi) => Promise<unknown>): Promise<Record<string, unknown>> {
    const original = globalThis.fetch;
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, result: {} }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    try {
        await run(new TelegramApi('token'));
    } finally {
        globalThis.fetch = original;
    }
    return captured;
}

describe('sendMessage wire format', () => {
    it('puts message_thread_id in the request body', async () => {
        const body = await captureBody(api => api.sendMessage({
            chat_id: 1,
            message_thread_id: 77,
            text: 'hi',
        }));

        expect(body.message_thread_id).toBe(77);
    });

    it('omits the field entirely outside topics', async () => {
        const body = await captureBody(api => api.sendMessage({ chat_id: 1, text: 'hi' }));

        expect('message_thread_id' in body).toBe(false);
    });
});

describe('sendMessageDraft wire format', () => {
    it('carries the thread id too', async () => {
        const body = await captureBody(api => api.sendMessageDraft({
            chat_id: 1,
            message_thread_id: 77,
            draft_id: 5,
            text: 'hi',
        }));

        expect(body.message_thread_id).toBe(77);
    });
});
