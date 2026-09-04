import type { TelegramApi } from './api';
import { markdownToRichBlocks } from './rich';
import { splitMessage, TELEGRAM_MESSAGE_LIMIT } from './split';

export interface DeliverOptions {
    chatId: number;
    threadId?: number;
    /** Ответы длиннее порога уходят файлом .md, а не серией сообщений. */
    documentThreshold: number;
    useRichMessages: boolean;
}

/**
 * deliverAnswer sends the final answer using the best available representation.
 *
 * Порядок выбора: длинный ответ -> файл .md с коротким превью;
 * иначе rich message; при отказе Telegram — простой текст кусками.
 */
export async function deliverAnswer(
    api: TelegramApi,
    text: string,
    options: DeliverOptions,
): Promise<void> {
    if (text.trim() === '') {
        return;
    }

    if (text.length > options.documentThreshold) {
        const sent = await sendAsDocument(api, text, options);
        if (sent) {
            return;
        }
    }

    if (options.useRichMessages) {
        const response = await api.sendRichMessage({
            chat_id: options.chatId,
            message_thread_id: options.threadId,
            rich_message: { blocks: markdownToRichBlocks(text) },
        });
        if (response.ok) {
            return;
        }
        // Rich Messages могут быть недоступны — падаем в обычный текст.
        console.error(JSON.stringify({
            msg: 'rich message rejected, falling back to plain text',
            description: response.description,
        }));
    }

    await sendPlainChunks(api, text, options);
}

async function sendAsDocument(
    api: TelegramApi,
    text: string,
    options: DeliverOptions,
): Promise<boolean> {
    const preview = buildPreview(text);
    const response = await api.sendDocument({
        chat_id: options.chatId,
        message_thread_id: options.threadId,
        filename: 'answer.md',
        content: text,
        caption: preview,
    });
    if (!response.ok) {
        console.error(JSON.stringify({
            msg: 'sendDocument failed, falling back to chunks',
            description: response.description,
        }));
        return false;
    }
    return true;
}

/**
 * buildPreview takes the opening of an answer to caption the attached file.
 */
export function buildPreview(text: string, limit = 900): string {
    const normalized = text.trim();
    if (normalized.length <= limit) {
        return normalized;
    }
    const window = normalized.slice(0, limit);
    const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
    const cut = boundary > limit * 0.5 ? boundary : window.length;
    return `${normalized.slice(0, cut).trimEnd()}\n\n[…полный ответ во вложении]`;
}

async function sendPlainChunks(
    api: TelegramApi,
    text: string,
    options: DeliverOptions,
): Promise<void> {
    for (const chunk of splitMessage(text, TELEGRAM_MESSAGE_LIMIT)) {
        const response = await api.sendMessage({
            chat_id: options.chatId,
            message_thread_id: options.threadId,
            text: chunk,
        });
        if (!response.ok) {
            break;
        }
    }
}
