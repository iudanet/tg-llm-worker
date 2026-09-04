import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import type { TelegramMessage } from '../telegram/types';
import { parseWhiteList } from '../config';
import { isAllowed } from '../handler';
import { buildPreview } from '../telegram/deliver';

function configWith(ids: string | undefined): Config {
    return {
        botToken: 't', webhookSecret: null, apiKey: 'k',
        apiBase: 'https://example.invalid/v1', model: 'm', systemPrompt: null,
        whiteList: parseWhiteList(ids), historyMaxMessages: 20,
        historyTtlSeconds: 60, streamIntervalMs: 1000,
        documentThreshold: 4096, useRichMessages: true,
    };
}

function messageFrom(userId: number): TelegramMessage {
    return {
        message_id: 1,
        from: { id: userId, is_bot: false, first_name: 'U' },
        chat: { id: userId, type: 'private' },
        date: 0,
        text: 'hi',
    };
}

describe('parseWhiteList', () => {
    it('parses ids and ignores blanks and junk', () => {
        expect(parseWhiteList(' 1, 2 ,,x, 3 ')).toEqual(new Set([1, 2, 3]));
    });

    it('returns an empty set for undefined', () => {
        expect(parseWhiteList(undefined).size).toBe(0);
    });
});

describe('isAllowed', () => {
    it('allows a whitelisted user', () => {
        expect(isAllowed(messageFrom(42), configWith('7,42'))).toBe(true);
    });

    it('rejects a user not on the list', () => {
        expect(isAllowed(messageFrom(99), configWith('7,42'))).toBe(false);
    });

    it('denies everyone when the list is empty (fail closed)', () => {
        expect(isAllowed(messageFrom(42), configWith(''))).toBe(false);
    });

    it('rejects a message without a sender', () => {
        const message = { ...messageFrom(42), from: undefined };
        expect(isAllowed(message, configWith('42'))).toBe(false);
    });
});

describe('buildPreview', () => {
    it('returns short text unchanged', () => {
        expect(buildPreview('short answer')).toBe('short answer');
    });

    it('truncates long text and marks the attachment', () => {
        const preview = buildPreview('a'.repeat(2000), 100);
        expect(preview.length).toBeLessThan(200);
        expect(preview).toContain('вложении');
    });
});
