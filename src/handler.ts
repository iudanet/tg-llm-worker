import type { Config } from './config';
import type { ChatMessage, ChatProvider } from './llm/provider';
import type { ConversationKey, HistoryStore } from './storage/history';
import type { TelegramApi } from './telegram/api';
import type { TelegramMessage, TelegramUpdate } from './telegram/types';
import { deliverAnswer } from './telegram/deliver';
import { DraftStreamer } from './telegram/stream';

/**
 * BOT_COMMANDS публикуется в меню Telegram при инициализации воркера.
 * Порядок важен: Telegram показывает команды именно в этом порядке,
 * а /start — первое, что видит новый пользователь.
 */
export const BOT_COMMANDS = [
    { command: 'start', description: 'Начать диалог' },
    { command: 'new', description: 'Очистить контекст и начать заново' },
    { command: 'help', description: 'Справка по боту' },
];

const START_TEXT = [
    'Привет! Задайте вопрос — отвечу с помощью языковой модели.',
    '',
    'Контекст диалога помню, /new его очищает. Подробнее — /help.',
].join('\n');

const HELP_TEXT = [
    'Команды:',
    '/start — начать диалог',
    '/new — начать новый диалог (очистить контекст)',
    '/help — эта справка',
    '',
    'История хранится отдельно для каждого топика, поэтому /new очищает',
    'только текущий разговор.',
].join('\n');

export interface HandlerDeps {
    api: TelegramApi;
    provider: ChatProvider;
    history: HistoryStore;
    config: Config;
}

/**
 * handleUpdate processes a single Telegram webhook update.
 */
export async function handleUpdate(update: TelegramUpdate, deps: HandlerDeps): Promise<void> {
    const message = update.message;
    if (!message?.from) {
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

    // Вложения пока не поддерживаются: молчание в ответ на фото выглядит
    // как поломка, поэтому явно говорим, чего бот не умеет.
    const unsupported = describeUnsupported(message);
    if (unsupported) {
        await deps.api.sendMessage({
            chat_id: message.chat.id,
            message_thread_id: message.message_thread_id,
            text: unsupported,
        });
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
 * describeUnsupported names the attachment kind the bot cannot handle yet.
 * Возвращает null, если сообщение обычное текстовое.
 */
export function describeUnsupported(message: TelegramMessage): string | null {
    if (message.photo?.length) {
        return 'Пока не умею читать картинки — распознавание изображений ещё не подключено. Опишите вопрос текстом.';
    }
    if (message.document) {
        return 'Пока не умею читать файлы. Пришлите содержимое текстом.';
    }
    if (message.voice || message.audio) {
        return 'Пока не умею распознавать голос и аудио. Напишите текстом.';
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

async function handleCommand(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const command = text.split(/\s+/)[0]?.split('@')[0];
    const chatId = message.chat.id;
    const key: ConversationKey = { chatId, threadId: message.message_thread_id };

    switch (command) {
        case '/start':
        case '/new':
            await deps.history.clear(key);
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                // /start у нового пользователя очищать нечего: приветствие
                // уместнее рапорта об очистке контекста.
                text: command === '/start' ? START_TEXT : 'Контекст очищен. Начинаем новый диалог.',
            });
            return;
        case '/help':
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                text: HELP_TEXT,
            });
            return;
        default:
            await deps.api.sendMessage({
                chat_id: chatId,
                message_thread_id: message.message_thread_id,
                text: `Неизвестная команда. ${HELP_TEXT}`,
            });
    }
}

async function handleChat(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const chatId = message.chat.id;
    const key: ConversationKey = { chatId, threadId: message.message_thread_id };
    const history = await deps.history.load(key);

    const conversation: ChatMessage[] = [];
    if (deps.config.systemPrompt) {
        conversation.push({ role: 'system', content: deps.config.systemPrompt });
    }
    conversation.push(...history, { role: 'user', content: text });

    const streamer = new DraftStreamer(deps.api, {
        chatId,
        threadId: message.message_thread_id,
        intervalMs: deps.config.streamIntervalMs,
    });
    await streamer.start();

    let answer: string;
    try {
        answer = await deps.provider.stream(conversation, {
            onDelta: accumulated => streamer.update(accumulated),
        });
    } catch (error) {
        console.error(JSON.stringify({
            msg: 'llm request failed',
            chat_id: chatId,
            error: error instanceof Error ? error.message : String(error),
        }));
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: message.message_thread_id,
            text: 'Не удалось получить ответ от модели. Попробуйте ещё раз.',
        });
        return;
    }

    await deliverAnswer(deps.api, answer, {
        chatId,
        threadId: message.message_thread_id,
        documentThreshold: deps.config.documentThreshold,
        useRichMessages: deps.config.useRichMessages,
    });

    await deps.history.save(key, [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: answer },
    ]);
}
