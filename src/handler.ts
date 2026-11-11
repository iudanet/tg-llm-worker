import type { Config } from './config';
import type { HandlerDeps } from './deps';
import type { TelegramMessage, TelegramUpdate } from './telegram/types';
import { destinationOf, Replier } from './telegram/reply';
import { enqueue } from './conversation/turn';
import { handleCommand } from './commands';
import { handlePhoto, handleVoice } from './media';

export type { HandlerDeps };
// Реэкспорт: routes.ts и тесты исторически берут их отсюда.
export { BOT_COMMANDS, buildInfoText } from './commands';

/**
 * handleUpdate processes a single Telegram webhook update.
 */
export async function handleUpdate(update: TelegramUpdate, deps: HandlerDeps): Promise<void> {
    const message = update.message;
    if (!message?.from) {
        return;
    }
    if (!hasSaneIds(message)) {
        console.error(JSON.stringify({ msg: 'update with malformed identifiers' }));
        return;
    }
    if (!isAllowed(message, deps.config)) {
        console.error(JSON.stringify({
            msg: 'rejected by whitelist',
            user_id: message.from.id,
            chat_id: message.chat.id,
        }));
        return;
    }

    if (message.photo?.length) {
        await handlePhoto(message.photo, message, deps);
        return;
    }

    const voice = message.voice ?? message.audio;
    if (voice) {
        await handleVoice(voice, message, deps);
        return;
    }

    // Остальные вложения не поддерживаются: молчание в ответ выглядит
    // как поломка, поэтому явно говорим, чего бот не умеет.
    const unsupported = describeUnsupported(message);
    if (unsupported) {
        await new Replier(deps.api, destinationOf(message)).text(unsupported);
        return;
    }

    const text = message.text?.trim();
    if (!text) {
        return;
    }
    if (text.startsWith('/')) {
        await handleCommand(text, message, deps);
        return;
    }
    await handleChat(text, message, deps);
}

/**
 * hasSaneIds rejects an update whose identifiers are not plain integers.
 *
 * Тело вебхука приводится к TelegramUpdate без проверки: типы существуют
 * только на этапе компиляции. Идентификаторы идут в ключи KV, и строка
 * вида "42:77" вместо числа дала бы ключ чужого топика. Граница доверия —
 * секрет вебхука, но одной проверки типов она стоить не должна.
 */
function hasSaneIds(message: TelegramMessage): boolean {
    const ids = [
        message.chat?.id,
        message.from?.id,
        message.message_id,
        // Топик необязателен: вне топиков Telegram его не присылает.
        ...(message.message_thread_id === undefined ? [] : [message.message_thread_id]),
    ];
    return ids.every(id => typeof id === 'number' && Number.isSafeInteger(id));
}

/**
 * describeUnsupported names the attachment kind the bot cannot handle yet.
 * Возвращает null, если сообщение обычное текстовое.
 */
export function describeUnsupported(message: TelegramMessage): string | null {
    if (message.document) {
        return 'Пока не умею читать файлы. Пришлите содержимое текстом.';
    }
    if (message.video) {
        return 'Пока не умею смотреть видео.';
    }
    if (message.sticker) {
        return 'На стикеры отвечать не умею — напишите текстом.';
    }
    return null;
}

/**
 * isAllowed checks the sender against the configured whitelist.
 */
export function isAllowed(message: TelegramMessage, config: Config): boolean {
    if (config.whiteList.size === 0) {
        return false;
    }
    const userId = message.from?.id;
    return userId !== undefined && config.whiteList.has(userId);
}

async function handleChat(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    await enqueue(message, deps, describeForward(message) + text);
}

/**
 * describeForward prefixes a forwarded message so the model knows its origin.
 * Без пометки модель принимает пересланный текст за слова пользователя.
 */
function describeForward(message: TelegramMessage): string {
    const origin = message.forward_origin;
    if (!origin) {
        return '';
    }
    const author = origin.sender_user?.first_name
        ?? origin.sender_user_name
        ?? origin.chat?.title
        ?? origin.author_signature;
    return author
        ? `[пересланное сообщение от ${author}]\n`
        : '[пересланное сообщение]\n';
}
