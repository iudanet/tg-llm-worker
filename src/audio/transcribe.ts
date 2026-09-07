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
 * audioFileName picks a file name whose extension matches the payload.
 *
 * Эндпоинт определяет формат по расширению, поэтому имя важнее, чем кажется:
 * без него OGG от Telegram может быть отвергнут как неизвестный формат.
 */
export function audioFileName(voice: TelegramVoice, filePath?: string): string {
    // Имя из Telegram (у audio-файлов) уже несёт верное расширение.
    if (voice.file_name && voice.file_name.includes('.')) {
        return voice.file_name;
    }
    // file_path от getFile тоже содержит расширение: voice/file_123.oga.
    const fromPath = filePath?.split('/').pop();
    if (fromPath?.includes('.')) {
        return fromPath;
    }
    return `audio.${extensionFor(voice.mime_type)}`;
}

/**
 * extensionFor maps a Telegram MIME type onto an extension the API accepts.
 */
export function extensionFor(mime: string | undefined): string {
    switch (mime) {
        case 'audio/ogg':
        case 'audio/opus':
            // Голосовые Telegram: контейнер OGG, кодек Opus.
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
