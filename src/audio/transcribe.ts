import type { TelegramVoice } from '../telegram/types';

/**
 * Транскрипция голосовых сообщений через OpenAI-совместимый эндпоинт
 * /v1/audio/transcriptions.
 *
 * Telegram отдаёт голосовые в OGG/Opus. В официальном списке форматов
 * эндпоинта ogg не значится, но на практике он принимается, поэтому файл
 * отправляется как есть: перекодировать аудио в воркере нечем (нет ffmpeg,
 * да и CPU-лимит это запрещает). Если формат всё же отвергнут, отказ
 * доводится до пользователя текстом, а не молчанием.
 */

export interface TranscribeOptions {
    apiKey: string;
    apiBase: string;
    model: string;
}

export interface TranscribeResult {
    text: string;
}

/** Ошибка распознавания с текстом, пригодным для показа пользователю. */
export class TranscribeError extends Error {
    readonly userMessage: string;

    constructor(message: string, userMessage: string) {
        super(message);
        this.name = 'TranscribeError';
        this.userMessage = userMessage;
    }
}

/**
 * Расширения, которые принимает эндпоинт транскрипции.
 * Списком проверяется всё, что приходит из Telegram: голосовые лежат
 * в файлах с расширением .oga, а его API отвергает («Unsupported file
 * format oga»), хотя тот же контейнер под именем .ogg принимается.
 */
const SUPPORTED_EXTENSIONS = new Set([
    'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm',
]);

/** Расширения, которые эндпоинт не знает, но которые сводятся к известным. */
const EXTENSION_ALIASES = new Map([
    // Голосовые Telegram: контейнер OGG, но файл назван .oga.
    ['oga', 'ogg'],
    ['opus', 'ogg'],
    ['ogv', 'ogg'],
]);

/**
 * audioFileName picks a file name whose extension the API accepts.
 *
 * Эндпоинт определяет формат по расширению, поэтому имя решает исход:
 * голосовые Telegram лежат по пути вида voice/file_123.oga, и это имя
 * отвергается. Расширение приводится к поддерживаемому, а при незнакомом
 * берётся из MIME-типа.
 */
export function audioFileName(voice: TelegramVoice, filePath?: string): string {
    const candidate = pickName(voice.file_name, filePath);
    const extension = candidate?.split('.').pop()?.toLowerCase();

    if (extension) {
        const alias = EXTENSION_ALIASES.get(extension);
        if (alias) {
            return `${stripExtension(candidate!)}.${alias}`;
        }
        if (SUPPORTED_EXTENSIONS.has(extension)) {
            return candidate!;
        }
    }
    // Расширения нет или оно незнакомо — доверяем MIME-типу.
    return `audio.${extensionFor(voice.mime_type)}`;
}

function pickName(fileName?: string, filePath?: string): string | undefined {
    if (fileName?.includes('.')) {
        return fileName;
    }
    const fromPath = filePath?.split('/').pop();
    return fromPath?.includes('.') ? fromPath : undefined;
}

function stripExtension(name: string): string {
    return name.slice(0, name.lastIndexOf('.'));
}

/**
 * extensionFor maps a Telegram MIME type onto an extension the API accepts.
 */
export function extensionFor(mime: string | undefined): string {
    switch (mime) {
        case 'audio/ogg':
        case 'audio/opus':
            // Голосовые Telegram: контейнер OGG, кодек Opus. Именно ogg,
            // а не oga: API знает только первое написание.
            return 'ogg';
        case 'audio/mpeg':
        case 'audio/mp3':
            return 'mp3';
        case 'audio/mp4':
        case 'audio/m4a':
        case 'audio/x-m4a':
            return 'm4a';
        case 'audio/wav':
        case 'audio/x-wav':
            return 'wav';
        case 'audio/webm':
            return 'webm';
        default:
            // Голосовые приходят без mime_type чаще прочего — считаем их OGG.
            return 'ogg';
    }
}

/**
 * describeTranscribeFailure turns an API error into a user-facing sentence.
 */
export function describeTranscribeFailure(status: number, body: string): string {
    const lower = body.toLowerCase();
    if (lower.includes('format') || lower.includes('unsupported') || status === 415) {
        return 'Не смог разобрать формат этой записи. Попробуйте переслать её файлом или напишите текстом.';
    }
    if (status === 413) {
        return 'Запись слишком длинная для распознавания.';
    }
    if (status === 429) {
        return 'Сервис распознавания перегружен, попробуйте ещё раз через минуту.';
    }
    return 'Не удалось распознать запись. Попробуйте ещё раз.';
}

/**
 * transcribe sends the audio payload to the transcription endpoint.
 */
export async function transcribe(
    audio: ArrayBuffer,
    fileName: string,
    mime: string | undefined,
    options: TranscribeOptions,
): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('model', options.model);
    form.append('file', new Blob([audio], { type: mime || 'audio/ogg' }), fileName);
    // Просим чистый текст: JSON-обёртка здесь ничего не добавляет.
    form.append('response_format', 'text');

    const response = await fetch(`${options.apiBase}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
    });

    const body = await response.text();
    if (!response.ok) {
        throw new TranscribeError(
            `transcription failed: ${response.status} ${body.slice(0, 500)}`,
            describeTranscribeFailure(response.status, body),
        );
    }

    const text = body.trim();
    if (text === '') {
        throw new TranscribeError(
            'transcription returned empty text',
            'В записи не разобрал слов. Попробуйте продиктовать ещё раз.',
        );
    }
    return { text };
}
