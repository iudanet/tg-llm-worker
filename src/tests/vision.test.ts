import { describe, expect, it } from 'vitest';
import type { StoredChatMessage } from '../llm/provider';
import type { TelegramPhotoSize } from '../telegram/types';
import { hydrateForLlm } from '../vision/hydrate';
import { imageKey, pickPhotoSize } from '../vision/store';

function size(width: number, height: number, fileSize?: number): TelegramPhotoSize {
    return {
        file_id: `f${width}x${height}`,
        file_unique_id: `u${width}x${height}`,
        width,
        height,
        ...(fileSize === undefined ? {} : { file_size: fileSize }),
    };
}

describe('pickPhotoSize', () => {
    it('takes the largest variant that fits the limit', () => {
        const picked = pickPhotoSize([
            size(90, 90, 2_000),
            size(320, 320, 30_000),
            size(1280, 1280, 300_000),
        ], 1_000_000);
        expect(picked?.width).toBe(1280);
    });

    it('skips variants over the limit instead of taking the largest', () => {
        // Крупнейший вариант не проходит лимит — берём следующий по величине.
        const picked = pickPhotoSize([
            size(320, 320, 30_000),
            size(1280, 1280, 5_000_000),
        ], 1_000_000);
        expect(picked?.width).toBe(320);
    });

    it('returns null when every variant is too big', () => {
        expect(pickPhotoSize([size(1280, 1280, 5_000_000)], 1_000_000)).toBeNull();
    });

    it('keeps a variant whose size is unknown — it is checked after download', () => {
        const picked = pickPhotoSize([size(1280, 1280)], 1_000_000);
        expect(picked?.width).toBe(1280);
    });

    it('compares by area, not by array order', () => {
        const picked = pickPhotoSize([
            size(1280, 1280, 300_000),
            size(320, 320, 30_000),
        ], 1_000_000);
        expect(picked?.width).toBe(1280);
    });

    it('returns null for an empty list', () => {
        expect(pickPhotoSize([], 1_000_000)).toBeNull();
    });
});

describe('imageKey', () => {
    it('scopes the key by chat, thread and file', () => {
        expect(imageKey({ chatId: 1, threadId: 7 }, 'abc')).toBe('img:1:7:abc');
    });

    it('omits the thread outside topics', () => {
        expect(imageKey({ chatId: 1 }, 'abc')).toBe('img:1:abc');
    });

    it('is stable for the same file — a resend reuses the key', () => {
        const first = imageKey({ chatId: 1, threadId: 7 }, 'abc');
        const second = imageKey({ chatId: 1, threadId: 7 }, 'abc');
        expect(first).toBe(second);
    });
});

/** Мок KV-читателя: отдаёт заранее положенные картинки. */
function fakeReader(stored: Record<string, string>) {
    return {
        async read(key: string): Promise<string | null> {
            return stored[key] ?? null;
        },
    };
}

const NO_REFETCH = {
    async refetch(): Promise<string | null> {
        return null;
    },
};

function textMessage(role: 'user' | 'assistant', text: string): StoredChatMessage {
    return { role, content: text };
}

function imageMessage(key: string, caption: string): StoredChatMessage {
    return {
        role: 'user',
        content: [
            { type: 'text', text: caption },
            { type: 'image_ref', key, fileId: `file-${key}`, mime: 'image/jpeg' },
        ],
    };
}

async function hydrate(history: StoredChatMessage[], options: {
    stored?: Record<string, string>;
    limit?: number;
    enabled?: boolean;
} = {}) {
    return hydrateForLlm(history, {
        reader: fakeReader(options.stored ?? {}),
        refetcher: NO_REFETCH,
        contextImages: options.limit ?? 2,
        enabled: options.enabled ?? true,
    });
}

/** Собирает типы частей одного сообщения — так удобнее проверять результат. */
function partTypes(message: { content: string | Array<{ type: string }> }): string[] {
    return typeof message.content === 'string' ? ['string'] : message.content.map(p => p.type);
}

describe('hydrateForLlm', () => {
    it('passes plain text messages through untouched', async () => {
        const result = await hydrate([textMessage('user', 'привет')]);
        expect(result).toEqual([{ role: 'user', content: 'привет' }]);
    });

    it('expands a stored reference into a data URL for the model', async () => {
        const result = await hydrate([imageMessage('img:1:a', 'что тут?')], {
            stored: { 'img:1:a': 'BASE64DATA' },
        });
        const parts = result[0]?.content as Array<{ type: string; url?: string }>;
        expect(parts[1]?.type).toBe('image');
        expect(parts[1]?.url).toBe('data:image/jpeg;base64,BASE64DATA');
    });

    it('never leaks image_ref to the provider', async () => {
        const result = await hydrate([imageMessage('img:1:a', 'что тут?')], {
            stored: { 'img:1:a': 'DATA' },
        });
        expect(partTypes(result[0]!)).not.toContain('image_ref');
    });

    it('keeps only the newest images and degrades older ones to text', async () => {
        const history = [
            imageMessage('img:1:old', 'первая'),
            imageMessage('img:1:mid', 'вторая'),
            imageMessage('img:1:new', 'третья'),
        ];
        const result = await hydrate(history, {
            stored: { 'img:1:old': 'A', 'img:1:mid': 'B', 'img:1:new': 'C' },
            limit: 2,
        });
        expect(partTypes(result[0]!)).toEqual(['text', 'text']);
        expect(partTypes(result[1]!)).toEqual(['text', 'image']);
        expect(partTypes(result[2]!)).toEqual(['text', 'image']);
    });

    it('degrades every image when vision is disabled', async () => {
        const result = await hydrate([imageMessage('img:1:a', 'что тут?')], {
            stored: { 'img:1:a': 'DATA' },
            enabled: false,
        });
        expect(partTypes(result[0]!)).toEqual(['text', 'text']);
    });

    it('falls back to a placeholder when the image has expired', async () => {
        // TTL картинки короче истории, поэтому промах KV — штатный случай.
        const result = await hydrate([imageMessage('img:1:gone', 'что тут?')]);
        const parts = result[0]?.content as Array<{ type: string; text?: string }>;
        expect(parts[1]?.type).toBe('text');
        expect(parts[1]?.text).toContain('недоступно');
    });

    it('refetches an expired image before giving up', async () => {
        const result = await hydrateForLlm([imageMessage('img:1:gone', 'что тут?')], {
            reader: fakeReader({}),
            refetcher: {
                async refetch(): Promise<string | null> {
                    return 'REFETCHED';
                },
            },
            contextImages: 2,
            enabled: true,
        });
        const parts = result[0]?.content as Array<{ type: string; url?: string }>;
        expect(parts[1]?.url).toBe('data:image/jpeg;base64,REFETCHED');
    });

    it('does not refetch images that are already degraded by the limit', async () => {
        let calls = 0;
        await hydrateForLlm([
            imageMessage('img:1:old', 'первая'),
            imageMessage('img:1:new', 'вторая'),
        ], {
            reader: fakeReader({ 'img:1:new': 'C' }),
            refetcher: {
                async refetch(): Promise<string | null> {
                    calls += 1;
                    return null;
                },
            },
            contextImages: 1,
            enabled: true,
        });
        // Старая картинка и так становится заглушкой — качать её незачем.
        expect(calls).toBe(0);
    });
});
