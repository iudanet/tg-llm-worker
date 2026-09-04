import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/provider';
import { trimHistory } from '../storage/history';

function history(count: number): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < count; i += 1) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
    }
    return messages;
}

describe('trimHistory', () => {
    it('keeps short history untouched', () => {
        const messages = history(4);
        expect(trimHistory(messages, 20)).toEqual(messages);
    });

    it('never exceeds the budget', () => {
        expect(trimHistory(history(50), 10).length).toBeLessThanOrEqual(10);
    });

    it('keeps the most recent messages', () => {
        const trimmed = trimHistory(history(50), 10);
        expect(trimmed.at(-1)?.content).toBe('m49');
    });

    it('starts the window with a user message', () => {
        const trimmed = trimHistory(history(50), 10);
        expect(trimmed[0]?.role).toBe('user');
    });

    it('returns everything when the budget is disabled', () => {
        const messages = history(6);
        expect(trimHistory(messages, 0)).toEqual(messages);
    });
});
