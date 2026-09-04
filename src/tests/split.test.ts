import { describe, expect, it } from 'vitest';
import { splitMessage, TELEGRAM_MESSAGE_LIMIT } from '../telegram/split';

describe('splitMessage', () => {
    it('returns empty array for empty input', () => {
        expect(splitMessage('')).toEqual([]);
    });

    it('keeps a short message as a single chunk', () => {
        expect(splitMessage('hello')).toEqual(['hello']);
    });

    it('never produces a chunk longer than the limit', () => {
        const text = 'a'.repeat(10_000);
        for (const chunk of splitMessage(text)) {
            expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
        }
    });

    it('preserves the full text across chunks', () => {
        const paragraph = `${'word '.repeat(200).trim()}\n\n`;
        const text = paragraph.repeat(10);
        const joined = splitMessage(text).join('\n\n').replace(/\s+/g, ' ').trim();
        expect(joined).toBe(text.replace(/\s+/g, ' ').trim());
    });

    it('prefers paragraph boundaries', () => {
        const first = 'x'.repeat(50);
        const second = 'y'.repeat(50);
        const chunks = splitMessage(`${first}\n\n${second}`, 60);
        expect(chunks).toEqual([first, second]);
    });

    it('falls back to a hard cut when no boundary exists', () => {
        const chunks = splitMessage('z'.repeat(25), 10);
        expect(chunks).toEqual(['zzzzzzzzzz', 'zzzzzzzzzz', 'zzzzz']);
    });
});
