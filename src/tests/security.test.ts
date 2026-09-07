import { describe, expect, it } from 'vitest';
import type { Env } from '../config';
import { loadConfig } from '../config';
import { escapeHtml } from '../routes';

function env(overrides: Partial<Env> = {}): Env {
    return {
        DATABASE: {} as KVNamespace,
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
        OPENAI_API_KEY: 'key',
        ...overrides,
    };
}

describe('loadConfig fails closed', () => {
    it('refuses to start without a bot token', () => {
        expect(() => loadConfig(env({ TELEGRAM_BOT_TOKEN: '' }))).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it('refuses to start without a webhook secret', () => {
        // Без секрета POST /webhook принимал бы апдейты от кого угодно,
        // а whitelist доверяет from.id из того же тела — то есть стал бы
        // декоративным. Это была реальная дыра, тест её закрывает.
        expect(() => loadConfig(env({ TELEGRAM_WEBHOOK_SECRET: '' }))).toThrow(
            /TELEGRAM_WEBHOOK_SECRET/,
        );
    });

    it('refuses an undefined webhook secret', () => {
        const raw = env();
        delete (raw as { TELEGRAM_WEBHOOK_SECRET?: string }).TELEGRAM_WEBHOOK_SECRET;
        expect(() => loadConfig(raw)).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    });

    it('keeps the secret as a plain string once configured', () => {
        expect(loadConfig(env()).webhookSecret).toBe('webhook-secret');
    });
});

describe('loadConfig rejects a plaintext API base', () => {
    it('refuses http — the key would travel in the clear', () => {
        expect(() => loadConfig(env({ OPENAI_API_BASE: 'http://proxy.invalid/v1' }))).toThrow(
            /https/,
        );
    });

    it('accepts https', () => {
        const config = loadConfig(env({ OPENAI_API_BASE: 'https://proxy.invalid/v1/' }));
        expect(config.apiBase).toBe('https://proxy.invalid/v1');
    });

    it('accepts the default base', () => {
        expect(loadConfig(env()).apiBase).toBe('https://api.openai.com/v1');
    });
});

describe('escapeHtml', () => {
    it('neutralises a script tag', () => {
        expect(escapeHtml('<script>alert(1)</script>')).toBe(
            '&lt;script&gt;alert(1)&lt;/script&gt;',
        );
    });

    it('escapes quotes and ampersands', () => {
        expect(escapeHtml(`"&'`)).toBe('&quot;&amp;&#39;');
    });

    it('leaves ordinary text untouched', () => {
        expect(escapeHtml('gpt-5-mini')).toBe('gpt-5-mini');
    });
});
