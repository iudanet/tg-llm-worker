import { describe, expect, it } from 'vitest';
import type { PendingBatch, PendingMessage } from '../batch/buffer';
import {
    appendPending,
    IMAGE_ONLY_QUESTION,
    isLastInBatch,
    mergeBatch,
    pendingKey,
    shouldWaitLonger,
} from '../batch/buffer';

function pending(id: number, content: PendingMessage['content']): PendingMessage {
    return { id, content };
}

describe('pendingKey', () => {
    it('scopes the buffer by chat and thread', () => {
        expect(pendingKey({ chatId: 1, threadId: 7 })).toBe('pending:1:7');
    });

    it('omits the thread outside topics', () => {
        expect(pendingKey({ chatId: 1 })).toBe('pending:1');
    });
});

describe('appendPending', () => {
    it('keeps messages ordered by id', () => {
        const result = appendPending([pending(5, 'b')], pending(3, 'a'));
        expect(result.map(m => m.id)).toEqual([3, 5]);
    });

    it('replaces a redelivered message instead of duplicating it', () => {
        // Telegram может доставить апдейт повторно.
        const result = appendPending([pending(3, 'старое')], pending(3, 'новое'));
        expect(result).toHaveLength(1);
        expect(result[0]?.content).toBe('новое');
    });
});

describe('isLastInBatch', () => {
    it('treats the highest id as the one that answers', () => {
        const batch: PendingBatch = { messages: [pending(1, 'a'), pending(2, 'b')] };
        expect(isLastInBatch(batch, 2)).toBe(true);
    });

    it('silences a message that has a newer sibling', () => {
        const batch: PendingBatch = { messages: [pending(1, 'a'), pending(2, 'b')] };
        expect(isLastInBatch(batch, 1)).toBe(false);
    });

    it('answers when it is alone', () => {
        expect(isLastInBatch({ messages: [pending(9, 'a')] }, 9)).toBe(true);
    });
});

describe('mergeBatch', () => {
    it('returns null for an empty batch', () => {
        expect(mergeBatch({ messages: [] })).toBeNull();
    });

    it('passes a single text message through unchanged', () => {
        const merged = mergeBatch({ messages: [pending(1, 'привет')] });
        expect(merged).toEqual({ role: 'user', content: 'привет' });
    });

    it('joins a forward and its comment into one question', () => {
        const merged = mergeBatch({
            messages: [pending(1, 'пересланный текст'), pending(2, 'что думаешь?')],
        });
        // Чистый текст возвращается строкой: в KV это компактнее массива.
        expect(merged?.content).toBe('пересланный текст\n\nчто думаешь?');
    });

    it('keeps images separate while merging the text around them', () => {
        const merged = mergeBatch({
            messages: [
                pending(1, [
                    { type: 'text', text: 'смотри' },
                    { type: 'image_ref', key: 'img:1', fileId: 'f', mime: 'image/jpeg' },
                ]),
                pending(2, 'что тут?'),
            ],
        });
        const parts = merged?.content as Array<{ type: string; text?: string }>;
        expect(parts.map(p => p.type)).toEqual(['text', 'image_ref', 'text']);
        expect(parts[2]?.text).toBe('что тут?');
    });

    it('merges two images from one album', () => {
        const merged = mergeBatch({
            messages: [
                pending(1, [{ type: 'image_ref', key: 'img:1', fileId: 'f1', mime: 'image/jpeg' }]),
                pending(2, [{ type: 'image_ref', key: 'img:2', fileId: 'f2', mime: 'image/jpeg' }]),
            ],
        });
        const parts = merged?.content as Array<{ type: string }>;
        // Подписи не было — вопрос подставляется первым, иначе модель
        // получила бы картинки без вопроса.
        expect(parts.map(p => p.type)).toEqual(['text', 'image_ref', 'image_ref']);
    });

    it('adds a default question when only images arrived', () => {
        const merged = mergeBatch({
            messages: [pending(1, [{ type: 'image_ref', key: 'k', fileId: 'f', mime: 'image/jpeg' }])],
        });
        const parts = merged?.content as Array<{ type: string; text?: string }>;
        expect(parts[0]).toEqual({ type: 'text', text: IMAGE_ONLY_QUESTION });
    });

    it('keeps the user caption instead of the default question', () => {
        const merged = mergeBatch({
            messages: [pending(1, [
                { type: 'text', text: 'что на схеме?' },
                { type: 'image_ref', key: 'k', fileId: 'f', mime: 'image/jpeg' },
            ])],
        });
        const parts = merged?.content as Array<{ type: string; text?: string }>;
        expect(parts[0]?.text).toBe('что на схеме?');
        expect(JSON.stringify(parts)).not.toContain(IMAGE_ONLY_QUESTION);
    });

    it('always produces a user message', () => {
        const merged = mergeBatch({ messages: [pending(1, 'a'), pending(2, 'b')] });
        expect(merged?.role).toBe('user');
    });
});

describe('shouldWaitLonger', () => {
    const WINDOW = 1500;

    it('keeps waiting while the burst is still arriving', () => {
        // Сообщение добавлено 500 мс назад — серия ещё идёт.
        const batch = { messages: [pending(1, 'a')], updatedAt: 10_000 };
        expect(shouldWaitLonger(batch, WINDOW, 10_500)).toBe(true);
    });

    it('stops waiting once the window of silence has passed', () => {
        const batch = { messages: [pending(1, 'a')], updatedAt: 10_000 };
        expect(shouldWaitLonger(batch, WINDOW, 11_500)).toBe(false);
    });

    it('treats the exact window boundary as silence', () => {
        const batch = { messages: [pending(1, 'a')], updatedAt: 10_000 };
        expect(shouldWaitLonger(batch, WINDOW, 10_000 + WINDOW)).toBe(false);
    });

    it('does not wait on a buffer without a timestamp', () => {
        // Записи от прежней версии воркера не должны подвешивать ответ.
        expect(shouldWaitLonger({ messages: [pending(1, 'a')] }, WINDOW, 10_000)).toBe(false);
    });

    it('does not wait when the clock went backwards', () => {
        // Изоляты в разных локациях могут расходиться по часам.
        const batch = { messages: [pending(1, 'a')], updatedAt: 10_000 };
        expect(shouldWaitLonger(batch, WINDOW, 9_000)).toBe(false);
    });
});
