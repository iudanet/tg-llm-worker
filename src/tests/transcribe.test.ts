import { describe, expect, it } from 'vitest';
import {
    audioFileName,
    describeTranscribeFailure,
    extensionFor,
    TranscribeError,
    transcribe,
} from '../audio/transcribe';

describe('extensionFor', () => {
    it('maps the Telegram voice mime onto ogg', () => {
        expect(extensionFor('audio/ogg')).toBe('ogg');
        expect(extensionFor('audio/opus')).toBe('ogg');
    });

    it('maps common audio mimes', () => {
        expect(extensionFor('audio/mpeg')).toBe('mp3');
        expect(extensionFor('audio/x-m4a')).toBe('m4a');
        expect(extensionFor('audio/wav')).toBe('wav');
    });

    it('assumes ogg when the mime is missing', () => {
        // Голосовые часто приходят без mime_type.
        expect(extensionFor(undefined)).toBe('ogg');
    });
});

describe('audioFileName', () => {
    it('prefers the name Telegram already provided', () => {
        expect(audioFileName({ file_id: 'f', file_name: 'запись.m4a' })).toBe('запись.m4a');
    });

    it('rewrites .oga into .ogg — the API rejects oga', () => {
        // Живой отказ: 400 "Unsupported file format oga".
        expect(audioFileName({ file_id: 'f' }, 'voice/file_12.oga')).toBe('file_12.ogg');
    });

    it('rewrites an .oga name coming from file_name too', () => {
        expect(audioFileName({ file_id: 'f', file_name: 'запись.oga' })).toBe('запись.ogg');
    });

    it('rewrites .opus into .ogg', () => {
        expect(audioFileName({ file_id: 'f' }, 'voice/note.opus')).toBe('note.ogg');
    });

    it('keeps a supported extension as is', () => {
        expect(audioFileName({ file_id: 'f' }, 'audio/file_3.mp3')).toBe('file_3.mp3');
    });

    it('falls back to the mime for an unknown extension', () => {
        expect(
            audioFileName({ file_id: 'f', mime_type: 'audio/ogg' }, 'voice/file.bin'),
        ).toBe('audio.ogg');
    });

    it('builds a name from the mime when nothing else is known', () => {
        expect(audioFileName({ file_id: 'f', mime_type: 'audio/ogg' })).toBe('audio.ogg');
    });

    it('ignores a provided name without an extension', () => {
        expect(audioFileName({ file_id: 'f', file_name: 'voice' })).toBe('audio.ogg');
    });
});

describe('describeTranscribeFailure', () => {
    it('explains a format rejection in plain words', () => {
        const text = describeTranscribeFailure(400, 'Unsupported file format: ogg');
        expect(text).toContain('формат');
    });

    it('reports an oversized recording', () => {
        expect(describeTranscribeFailure(413, '')).toContain('длинная');
    });

    it('reports rate limiting', () => {
        expect(describeTranscribeFailure(429, 'rate limit')).toContain('перегружен');
    });

    it('falls back to a generic message', () => {
        expect(describeTranscribeFailure(500, 'boom')).toContain('Не удалось');
    });
});

/** Подменяет глобальный fetch на время одного вызова. */
async function withFetch<T>(
    handler: (url: string, init: RequestInit) => Response,
    run: () => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        return handler(String(url), init ?? {});
    }) as typeof fetch;
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
    }
}

const OPTIONS = {
    apiKey: 'k',
    apiBase: 'https://example.invalid/v1',
    model: 'gpt-4o-mini-transcribe',
};

describe('transcribe', () => {
    it('returns the recognised text', async () => {
        const result = await withFetch(
            () => new Response('  привет из записи  ', { status: 200 }),
            () => transcribe(new ArrayBuffer(8), 'audio.ogg', 'audio/ogg', OPTIONS),
        );
        expect(result.text).toBe('привет из записи');
    });

    it('posts to the transcriptions endpoint with the model', async () => {
        let seenUrl = '';
        let seenModel: unknown = null;
        await withFetch(
            (url, init) => {
                seenUrl = url;
                seenModel = (init.body as FormData).get('model');
                return new Response('текст', { status: 200 });
            },
            () => transcribe(new ArrayBuffer(8), 'audio.ogg', 'audio/ogg', OPTIONS),
        );
        expect(seenUrl).toBe('https://example.invalid/v1/audio/transcriptions');
        expect(seenModel).toBe('gpt-4o-mini-transcribe');
    });

    it('sends the file name so the format can be detected', async () => {
        let name = '';
        await withFetch(
            (_url, init) => {
                const file = (init.body as FormData).get('file') as File;
                name = file.name;
                return new Response('текст', { status: 200 });
            },
            () => transcribe(new ArrayBuffer(8), 'file_12.oga', 'audio/ogg', OPTIONS),
        );
        expect(name).toBe('file_12.oga');
    });

    it('raises a user-facing error when the format is rejected', async () => {
        await expect(withFetch(
            () => new Response('Unsupported file format', { status: 400 }),
            () => transcribe(new ArrayBuffer(8), 'audio.ogg', 'audio/ogg', OPTIONS),
        )).rejects.toThrow(TranscribeError);
    });

    it('carries a readable message on the error', async () => {
        try {
            await withFetch(
                () => new Response('Unsupported file format', { status: 400 }),
                () => transcribe(new ArrayBuffer(8), 'audio.ogg', 'audio/ogg', OPTIONS),
            );
            expect.unreachable('should have thrown');
        } catch (error) {
            expect((error as TranscribeError).userMessage).toContain('формат');
        }
    });

    it('treats an empty transcript as a failure', async () => {
        // Тишина в записи — не повод отвечать пустотой.
        await expect(withFetch(
            () => new Response('   ', { status: 200 }),
            () => transcribe(new ArrayBuffer(8), 'audio.ogg', 'audio/ogg', OPTIONS),
        )).rejects.toThrow(TranscribeError);
    });
});
