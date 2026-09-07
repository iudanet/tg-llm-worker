import type { Config } from './config';
import type {
    ChatMessage,
    ChatProvider,
    ImageRefPart,
    StoredChatMessage,
} from './llm/provider';
import type { ConversationKey, HistoryStore } from './storage/history';
import type { ImageStore } from './vision/store';
import type { TelegramApi } from './telegram/api';
import type { TelegramMessage, TelegramPhotoSize, TelegramUpdate } from './telegram/types';
import { deliverAnswer } from './telegram/deliver';
import { DraftStreamer } from './telegram/stream';
import { topicNameFrom } from './telegram/title';
import { hydrateForLlm } from './vision/hydrate';
import { imageKey, pickPhotoSize, toBase64 } from './vision/store';

/**
 * BOT_COMMANDS публикуется в меню Telegram при инициализации воркера.
 * Порядок важен: Telegram показывает команды именно в этом порядке,
 * а /start — первое, что видит новый пользователь.
 */
export const BOT_COMMANDS = [
    { command: 'start', description: 'Начать диалог' },
    { command: 'new', description: 'Очистить контекст и начать заново' },
    { command: 'delete', description: 'Удалить этот топик вместе с контекстом' },
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
    '/delete — удалить этот топик вместе с контекстом',
    '/help — эта справка',
    '',
    'История хранится отдельно для каждого топика, поэтому /new очищает',
    'только текущий разговор.',
    '',
    'Telegram не сообщает боту об удалении топика вручную: в этом случае',
    'контекст исчезнет сам по таймауту. /delete убирает его сразу.',
].join('\n');

export interface HandlerDeps {
    api: TelegramApi;
    provider: ChatProvider;
    history: HistoryStore;
    /** Хранилище картинок: отдельные ключи, чтобы не раздувать историю. */
    images: ImageStore;
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

    if (message.photo?.length) {
        await handlePhoto(message.photo, message, deps);
        return;
    }

    // Остальные вложения не поддерживаются: молчание в ответ выглядит
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
        case '/delete':
            await deleteConversation(message, deps);
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

/**
 * deleteConversation drops the stored context and removes the topic itself.
 *
 * Bot API не присылает событий об удалении топика пользователем, поэтому
 * удаление инициирует бот. Порядок шагов важен:
 *   1) чистим KV — это главное, что обещает команда;
 *   2) отвечаем, пока топик ещё существует: в удалённый уже не доставить;
 *   3) удаляем топик — отказ метода не должен отменять первые два шага.
 */
async function deleteConversation(message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    const key: ConversationKey = { chatId, threadId };

    await deps.history.clear(key);

    // Вне топика удалять нечего — команда вырождается в очистку контекста.
    if (threadId === undefined) {
        await deps.api.sendMessage({
            chat_id: chatId,
            text: 'Контекст очищен. Этот чат без топиков, поэтому удалять нечего.',
        });
        return;
    }

    await deps.api.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: 'Контекст очищен, удаляю топик.',
    });

    const result = await deps.api.deleteForumTopic(chatId, threadId);
    if (!result.ok) {
        // Топик остался, но контекст уже забыт — сообщаем, что осталось сделать руками.
        console.error(JSON.stringify({
            msg: 'deleteForumTopic failed',
            chat_id: chatId,
            message_thread_id: threadId,
            description: result.description,
        }));
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Контекст очищен, но удалить топик не удалось — удалите его вручную.',
        });
    }
}

/**
 * handlePhoto stores the image and asks the model about it.
 *
 * Картинка не кладётся в блоб истории: она уходит в свой KV-ключ, а в
 * истории остаётся ссылка. Иначе каждое последующее сообщение читало и
 * писало бы мегабайты base64.
 */
async function handlePhoto(
    photo: TelegramPhotoSize[],
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;

    if (!deps.config.visionEnabled) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Обработка картинок отключена в настройках бота.',
        });
        return;
    }

    const limitMb = (deps.config.imageMaxBytes / (1024 * 1024)).toFixed(1);
    const size = pickPhotoSize(photo, deps.config.imageMaxBytes);
    if (!size) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: `Картинка слишком большая — лимит ${limitMb} МБ.`,
        });
        return;
    }

    const stored = await storePhoto(size, { chatId, threadId }, deps);
    if (!stored) {
        await deps.api.sendMessage({
            chat_id: chatId,
            message_thread_id: threadId,
            text: 'Не удалось загрузить картинку из Telegram. Попробуйте ещё раз.',
        });
        return;
    }

    // Подпись к фото и есть вопрос пользователя; без неё спрашиваем сами.
    const caption = message.caption?.trim() || 'Что на этом изображении?';
    await runTurn({
        role: 'user',
        content: [{ type: 'text', text: caption }, stored],
    }, message, deps);
}

/**
 * storePhoto downloads one photo variant and keeps it in KV.
 * Возвращает ссылку для истории или null, если картинку получить не удалось.
 */
async function storePhoto(
    size: TelegramPhotoSize,
    scope: { chatId: number; threadId?: number },
    deps: HandlerDeps,
): Promise<ImageRefPart | null> {
    const file = await deps.api.getFile(size.file_id);
    if (!file.ok || !file.result?.file_path) {
        return null;
    }

    const buffer = await deps.api.downloadFile(file.result.file_path);
    if (!buffer) {
        return null;
    }
    // file_size необязателен, поэтому фактический размер проверяем после скачивания.
    if (buffer.byteLength > deps.config.imageMaxBytes) {
        console.error(JSON.stringify({
            msg: 'photo over the limit after download',
            bytes: buffer.byteLength,
            limit: deps.config.imageMaxBytes,
        }));
        return null;
    }

    const key = imageKey(scope, size.file_unique_id);
    await deps.images.write(key, toBase64(buffer));
    return { type: 'image_ref', key, fileId: size.file_id, mime: 'image/jpeg' };
}

async function handleChat(text: string, message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    await runTurn({ role: 'user', content: text }, message, deps);
}

/**
 * runTurn drives one exchange: stream the answer, deliver it, persist history.
 * Общий путь для текста и картинок — различие только в составе сообщения.
 */
async function runTurn(
    userMessage: StoredChatMessage,
    message: TelegramMessage,
    deps: HandlerDeps,
): Promise<void> {
    const chatId = message.chat.id;
    const key: ConversationKey = { chatId, threadId: message.message_thread_id };
    const history = await deps.history.load(key);

    // Пустая история = первое сообщение в топике: только здесь ставим имя,
    // чтобы не перебивать заголовок, заданный пользователем вручную.
    if (history.length === 0) {
        await nameTopic(message, deps);
    }

    const stored: StoredChatMessage[] = [...history, userMessage];
    // Ссылки на картинки разворачиваются в data-URL только здесь: в KV
    // и дальше по коду они остаются ссылками.
    const conversation: ChatMessage[] = await hydrateForLlm(stored, {
        reader: deps.images,
        refetcher: { refetch: ref => refetchImage(ref, deps) },
        contextImages: deps.config.visionContextImages,
        enabled: deps.config.visionEnabled,
    });
    if (deps.config.systemPrompt) {
        conversation.unshift({ role: 'system', content: deps.config.systemPrompt });
    }

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

    await deps.history.save(key, [...stored, { role: 'assistant', content: answer }]);
}

/**
 * nameTopic titles a fresh topic after the user's first message.
 *
 * Клиент Telegram называет новый топик «Новый чат» — осмысленный заголовок
 * ставит бот. Неудача переименования сознательно игнорируется: имя топика
 * косметика, из-за него ответ пользователю ломаться не должен.
 */
async function nameTopic(message: TelegramMessage, deps: HandlerDeps): Promise<void> {
    const threadId = message.message_thread_id;
    if (threadId === undefined) {
        // Вне топиков переименовывать нечего.
        return;
    }
    const source = message.text ?? message.caption ?? '';
    const name = topicNameFrom(source);
    if (!name) {
        return;
    }

    const result = await deps.api.editForumTopic(message.chat.id, threadId, name);
    if (!result.ok) {
        console.error(JSON.stringify({
            msg: 'editForumTopic failed',
            chat_id: message.chat.id,
            message_thread_id: threadId,
            description: result.description,
        }));
    }
}

/**
 * refetchImage pulls an image back from Telegram after its KV entry expired.
 * TTL картинки короче TTL истории, поэтому такой промах — ожидаемый случай.
 */
async function refetchImage(ref: ImageRefPart, deps: HandlerDeps): Promise<string | null> {
    const file = await deps.api.getFile(ref.fileId);
    if (!file.ok || !file.result?.file_path) {
        return null;
    }
    const buffer = await deps.api.downloadFile(file.result.file_path);
    if (!buffer) {
        return null;
    }
    const base64 = toBase64(buffer);
    // Возвращаем в KV, чтобы следующий вопрос по этой картинке не качал её снова.
    await deps.images.write(ref.key, base64);
    return base64;
}
