import { describe, expect, it } from 'vitest';
import { TOPIC_NAME_LIMIT, topicNameFrom } from '../telegram/title';

describe('topicNameFrom', () => {
    it('keeps a short message as is', () => {
        expect(topicNameFrom('Как работает KV?')).toBe('Как работает KV?');
    });

    it('trims surrounding whitespace', () => {
        expect(topicNameFrom('  привет  ')).toBe('привет');
    });

    it('collapses newlines into spaces — a topic name is single-line', () => {
        expect(topicNameFrom('первая строка\nвторая строка')).toBe('первая строка вторая строка');
    });

    it('collapses repeated whitespace', () => {
        expect(topicNameFrom('слово     другое')).toBe('слово другое');
    });

    it('cuts a long message on a word boundary', () => {
        const long = 'Расскажи подробно про устройство Cloudflare Workers и как там работает KV-хранилище';
        const name = topicNameFrom(long);
        expect(name).not.toBeNull();
        expect(name!.length).toBeLessThanOrEqual(TOPIC_NAME_LIMIT);
        expect(name!.endsWith('…')).toBe(true);
        // Обрезка по слову: начало имени совпадает с началом сообщения.
        expect(long.startsWith(name!.slice(0, -1))).toBe(true);
    });

    it('never exceeds the Telegram limit', () => {
        const name = topicNameFrom('слово '.repeat(100));
        expect(name!.length).toBeLessThanOrEqual(TOPIC_NAME_LIMIT);
    });

    it('hard-cuts a single very long word', () => {
        // Границы слова нет — режем жёстко, иначе имя не влезет в лимит.
        const name = topicNameFrom('а'.repeat(200));
        expect(name!.length).toBeLessThanOrEqual(TOPIC_NAME_LIMIT);
        expect(name!.endsWith('…')).toBe(true);
    });

    it('returns null for text that leaves nothing usable', () => {
        expect(topicNameFrom('   ')).toBeNull();
        expect(topicNameFrom('')).toBeNull();
    });

    it('strips a leading slash so a name never looks like a command', () => {
        expect(topicNameFrom('/new что дальше')).toBe('что дальше');
    });

    it('returns null when only a command is left', () => {
        expect(topicNameFrom('/help')).toBeNull();
    });
});
