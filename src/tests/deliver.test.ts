import { describe, expect, it, vi } from 'vitest';
import type { TelegramApi } from '../telegram/api';
import { buildPreview, CAPTION_LIMIT, deliverAnswer } from '../telegram/deliver';
import type { ApiResponse, TelegramMessage } from '../telegram/types';

const OK: ApiResponse<TelegramMessage> = {
    ok: true,
    result: { message_id: 1, chat: { id: 1, type: 'private' } } as TelegramMessage,
};

function failure(description: string): ApiResponse<TelegramMessage> {
    return { ok: false, error_code: 400, description };
}

interface ApiStub {
    sendMessage: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendRichMessage: ReturnType<typeof vi.fn>;
}

/**
 * stubApi builds a minimal TelegramApi double with per-method scripted answers.
 */
function stubApi(overrides: Partial<ApiStub> = {}): ApiStub {
    return {
        sendMessage: vi.fn(async () => OK),
        sendDocument: vi.fn(async () => OK),
        sendRichMessage: vi.fn(async () => OK),
        ...overrides,
    };
}

/** asApi hands the stub to production code, which only needs these methods. */
function asApi(stub: ApiStub): TelegramApi {
    return stub as unknown as TelegramApi;
}

const BASE = { chatId: 1, documentThreshold: 4096, useRichMessages: false };

describe('deliverAnswer', () => {
    it('falls back to plain chunks when the document upload fails', async () => {
        const api = stubApi({ sendDocument: vi.fn(async () => failure('Request Entity Too Large')) });
        const text = 'a'.repeat(5000);

        await deliverAnswer(asApi(api), text, BASE);

        expect(api.sendMessage).toHaveBeenCalled();
        const delivered = api.sendMessage.mock.calls
            .map(call => (call[0] as { text: string }).text)
            .join('');
        expect(delivered.length).toBeGreaterThan(4000);
    });

    it('keeps sending the remaining chunks after one chunk is rejected', async () => {
        // Регрессия: раньше цикл делал break и терял хвост ответа целиком.
        let call = 0;
        const api = stubApi({
            sendMessage: vi.fn(async () => {
                call += 1;
                return call === 1 ? failure('Bad Request: message text is empty') : OK;
            }),
        });

        await deliverAnswer(asApi(api), 'b'.repeat(9000), { ...BASE, documentThreshold: 100_000 });

        expect(api.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('reports a failure to the user when every chunk is rejected', async () => {
        // Иначе пользователь видит только исчезнувший черновик и тишину.
        const api = stubApi({ sendMessage: vi.fn(async () => failure('Forbidden: bot was blocked')) });

        await deliverAnswer(asApi(api), 'short answer', BASE);

        expect(api.sendMessage).toHaveBeenCalled();
    });

    it('falls back to chunks when a rich message is rejected', async () => {
        const api = stubApi({ sendRichMessage: vi.fn(async () => failure('Bad Request: unknown method')) });

        await deliverAnswer(asApi(api), 'hello', { ...BASE, useRichMessages: true });

        expect(api.sendMessage).toHaveBeenCalledOnce();
        const [params] = api.sendMessage.mock.calls[0] as [{ text: string }];
        expect(params.text).toBe('hello');
    });

    it('sends nothing for an empty answer', async () => {
        const api = stubApi();
        await deliverAnswer(asApi(api), '   ', BASE);
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(api.sendDocument).not.toHaveBeenCalled();
    });
});

describe('buildPreview', () => {
    it('keeps a short answer intact', () => {
        expect(buildPreview('short')).toBe('short');
    });

    it('never exceeds the Telegram caption limit', () => {
        // Лимит caption — 1024 символа; превью плюс маркер обязаны в него влезть.
        const preview = buildPreview('x'.repeat(5000));
        expect(preview.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    });

    it('never exceeds the caption limit when the text has no break points', () => {
        const preview = buildPreview(`${'слово '.repeat(400)}`);
        expect(preview.length).toBeLessThanOrEqual(CAPTION_LIMIT);
    });
});
