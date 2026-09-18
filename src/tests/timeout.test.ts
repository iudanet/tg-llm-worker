import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import type { Env } from '../config';

const BASE_ENV = {
    DATABASE: {} as KVNamespace,
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    OPENAI_API_KEY: 'key',
} as Env;

describe('reasoning effort config', () => {
    it('defaults to low so the thinking phase fits the waitUntil budget', () => {
        expect(loadConfig(BASE_ENV).reasoningEffort).toBe('low');
    });

    it('accepts the documented levels', () => {
        for (const level of ['minimal', 'low', 'medium', 'high']) {
            expect(loadConfig({ ...BASE_ENV, REASONING_EFFORT: level }).reasoningEffort).toBe(level);
        }
    });

    it('treats off and an empty value as "do not send the parameter"', () => {
        // Обычные модели отвечают ошибкой на reasoning_effort, поэтому нужен
        // способ выключить его, не трогая код.
        expect(loadConfig({ ...BASE_ENV, REASONING_EFFORT: 'off' }).reasoningEffort).toBeNull();
        expect(loadConfig({ ...BASE_ENV, REASONING_EFFORT: '' }).reasoningEffort).toBeNull();
    });

    it('rejects an unknown level instead of failing at request time', () => {
        expect(() => loadConfig({ ...BASE_ENV, REASONING_EFFORT: 'turbo' })).toThrow(/REASONING_EFFORT/);
    });
});

describe('generation timeout config', () => {
    it('leaves room for delivery inside the 30s waitUntil budget', () => {
        const { generationTimeoutMs, batchMaxWaitMs } = loadConfig(BASE_ENV);
        expect(generationTimeoutMs).toBe(18000);
        // Сбор серии и генерация идут последовательно, и после них ещё нужно
        // успеть отправить ответ — иначе воркер умрёт ровно как в проде.
        expect(batchMaxWaitMs + generationTimeoutMs).toBeLessThan(30000);
    });

    it('can be overridden', () => {
        expect(loadConfig({ ...BASE_ENV, GENERATION_TIMEOUT_MS: '5000' }).generationTimeoutMs).toBe(5000);
    });
});
