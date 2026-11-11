import type { TelegramApi } from './api';
import { markdownToRichBlocks } from './rich';
import { splitMessage, TELEGRAM_MESSAGE_LIMIT } from './split';

export interface DeliverOptions {
    chatId: number;
    threadId?: number;
    /**
     * Сообщение, на которое отвечаем.
     *
     * В личных чатах Telegram не всегда кладёт ответ в тред по одному
     * message_thread_id: ответ оседает в общем потоке. Привязка к исходному
     * сообщению задаёт тред через цепочку ответов — её клиент понимает.
     */
    replyToMessageId?: number;
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
            ...replyParameters(options),
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
        ...replyParameters(options),
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

/** Предел подписи к вложению в Bot API. */
export const CAPTION_LIMIT = 1024;

const ATTACHMENT_NOTE = '\n\n[…полный ответ во вложении]';

/**
 * buildPreview takes the opening of an answer to caption the attached file.
 *
 * Результат гарантированно укладывается в CAPTION_LIMIT вместе с пометкой о
 * вложении: подпись длиннее лимита Telegram отвергает целиком, и тогда
 * пользователь не получает ни файла, ни текста.
 */
export function buildPreview(text: string, limit = CAPTION_LIMIT - ATTACHMENT_NOTE.length): string {
    const budget = Math.min(limit, CAPTION_LIMIT - ATTACHMENT_NOTE.length);
    const normalized = text.trim();
    if (normalized.length <= budget) {
        return normalized;
    }
    const window = normalized.slice(0, budget);
    const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
    const cut = boundary > budget * 0.5 ? boundary : window.length;
    return `${normalized.slice(0, cut).trimEnd()}${ATTACHMENT_NOTE}`;
}

/**
 * FATAL_DELIVERY_CODES mark failures that will repeat for every chunk.
 *
 * 403 — бот заблокирован или выкинут из чата, 429 — лимит частоты. В обоих
 * случаях остальные куски тоже не пройдут, а попытки съедают бюджет
 * waitUntil, после которого не успеет сохраниться история.
 */
const FATAL_DELIVERY_CODES = new Set([403, 429]);

/**
 * sendPlainChunks is the last delivery route, so it must never fail silently.
 *
 * Разовый отказ (например, на пустом куске) не означает отказ на остальных —
 * продолжаем, иначе хвост длинного ответа пропадает без следа. А отказ,
 * который повторится для всей серии, прерывает её сразу. Если не дошёл ни
 * один кусок, говорим об этом: иначе пользователь видит только исчезнувший
 * черновик и тишину.
 */
async function sendPlainChunks(
    api: TelegramApi,
    text: string,
    options: DeliverOptions,
): Promise<void> {
    const chunks = splitMessage(text, TELEGRAM_MESSAGE_LIMIT);
    let delivered = 0;
    let fatal = false;

    for (const chunk of chunks) {
        const response = await api.sendMessage({
            chat_id: options.chatId,
            message_thread_id: options.threadId,
            // Привязываем только первый кусок: дальше тред уже задан, а
            // цитата у каждого сообщения серии выглядит шумно.
            ...(delivered === 0 ? replyParameters(options) : {}),
            text: chunk,
        });
        if (response.ok) {
            delivered += 1;
            continue;
        }
        console.error(JSON.stringify({
            msg: 'chunk delivery failed',
            chat_id: options.chatId,
            chunk_length: chunk.length,
            error_code: response.error_code,
            description: response.description,
        }));

        if (response.error_code !== undefined && FATAL_DELIVERY_CODES.has(response.error_code)) {
            fatal = true;
            break;
        }
    }

    // При фатальном отказе уведомление не дойдёт тем же путём — не пытаемся.
    if (delivered === 0 && chunks.length > 0 && !fatal) {
        await notifyDeliveryFailure(api, options);
    }
}

/**
 * replyParameters binds the answer to the question that triggered it.
 *
 * allow_sending_without_reply обязателен: пользователь может удалить свой
 * вопрос, и без флага Telegram отклонит весь ответ.
 */
function replyParameters(options: DeliverOptions) {
    return options.replyToMessageId === undefined
        ? {}
        : {
            reply_parameters: {
                message_id: options.replyToMessageId,
                allow_sending_without_reply: true,
            },
        };
}

/**
 * notifyDeliveryFailure tells the user the answer exists but could not be sent.
 */
async function notifyDeliveryFailure(api: TelegramApi, options: DeliverOptions): Promise<void> {
    const response = await api.sendMessage({
        chat_id: options.chatId,
        message_thread_id: options.threadId,
        text: 'Ответ сформирован, но Telegram отклонил его отправку. Попробуйте переспросить.',
    });
    if (!response.ok) {
        console.error(JSON.stringify({
            msg: 'delivery failure notice rejected',
            chat_id: options.chatId,
            description: response.description,
        }));
    }
}
